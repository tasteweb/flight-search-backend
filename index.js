import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

let amadeusToken = null;
let amadeusTokenExpiry = 0;

async function getAmadeusToken() {
  const now = Date.now();

  if (amadeusToken && now < amadeusTokenExpiry) return amadeusToken;

  const response = await axios.post(
    "https://test.api.amadeus.com/v1/security/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  amadeusToken = response.data.access_token;
  amadeusTokenExpiry =
    now + response.data.expires_in * 1000 - 60000;

  return amadeusToken;
}

/* ---------------- city / airport resolver ---------------- */

async function resolveLocation(input, token) {
  const trimmed = input.trim();

  if (/^[a-zA-Z]{3}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  const res = await axios.get(
    "https://test.api.amadeus.com/v1/reference-data/locations",
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        keyword: trimmed,
        subType: "AIRPORT,CITY",
        view: "LIGHT",
        "page[limit]": 10
      }
    }
  );

  const data = res.data?.data || [];

  const airport = data.find(l => l.subType === "AIRPORT" && l.iataCode);
  const city = data.find(l => l.subType === "CITY" && l.iataCode);

  if (airport) return airport.iataCode;
  if (city) return city.iataCode;

  const firstWithCode = data.find(l => l.iataCode);
  if (firstWithCode) return firstWithCode.iataCode;

  return null;
}

/* ---------------- search flights ---------------- */

app.post("/api/search-flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      returnDate,
      adults,
      children,
      tripType,
      page = 1
    } = req.body;

    if (!origin || !destination || !date || !adults) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const token = await getAmadeusToken();

    const originCode = await resolveLocation(origin, token);
    const destinationCode = await resolveLocation(destination, token);

    if (!originCode) {
      return res.status(400).json({ error: "Origin location not found" });
    }

    if (!destinationCode) {
      return res.status(400).json({ error: "Destination location not found" });
    }

    const params = {
      originLocationCode: originCode,
      destinationLocationCode: destinationCode,
      departureDate: date,
      adults: Number(adults),
      children: Number(children || 0),
      currencyCode: "SAR",
      max: 50
    };

    if (tripType === "roundtrip" && returnDate) {
      params.returnDate = returnDate;
    }

    const response = await axios.get(
      "https://test.api.amadeus.com/v2/shopping/flight-offers",
      {
        headers: { Authorization: `Bearer ${token}` },
        params
      }
    );

    const offers = response.data?.data || [];

    const pageSize = 10;
    const start = (page - 1) * pageSize;

    const slice = offers.slice(start, start + pageSize);

    const normalized = slice.map(flight => {
      const itinerary = flight.itineraries[0];
      const segments = itinerary.segments;

      const baggage =
        flight.travelerPricings?.[0]?.fareDetailsBySegment?.map(f => ({
          segmentId: f.segmentId,
          checkedBags: f.includedCheckedBags?.quantity ?? 0,
          cabinBags: f.includedCabinBags?.quantity ?? 0
        })) || [];

      return {
        id: flight.id,
        price: flight.price.grandTotal,
        currency: flight.price.currency,
        totalDuration: itinerary.duration,
        stops: segments.length - 1,
        segments: segments.map(s => ({
          from: s.departure.iataCode,
          to: s.arrival.iataCode,
          depart: s.departure.at,
          arrive: s.arrival.at,
          airline: s.carrierCode,
          flightNumber: s.number,
          duration: s.duration
        })),
        baggage
      };
    });

    res.json({
      page,
      total: offers.length,
      results: normalized
    });

  } catch (err) {

    console.error("SEARCH ERROR:", err.response?.data || err.message);

    res
      .status(err.response?.status || 500)
      .json({
        error: "Flight search failed",
        details: err.response?.data || err.message
      });
  }
});

/* ---------------- booking request ---------------- */

app.post("/api/booking-request", async (req, res) => {
  const { name, email, phone, notes, flight } = req.body;

  if (!name || !email || !flight) {
    return res.status(400).json({ error: "Missing fields" });
  }

  let layoverText = "None";

  if (flight.segments && flight.segments.length > 1) {
    layoverText = "";

    for (let i = 0; i < flight.segments.length - 1; i++) {
      const arrive = new Date(flight.segments[i].arrive);
      const depart = new Date(flight.segments[i + 1].depart);

      const mins = Math.floor((depart - arrive) / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;

      layoverText += `Layover in ${flight.segments[i].to}: ${h}h ${m}m\n`;
    }
  }

  let baggageText = "Not available";

  if (flight.baggage && flight.baggage.length) {
    baggageText = flight.baggage
      .map((b, i) =>
        `Segment ${i + 1}: Checked ${b.checkedBags}, Cabin ${b.cabinBags}`
      )
      .join("\n");
  }

  const agencyText = `
New booking request

Customer details
----------------
Name: ${name}
Email: ${email}
Phone: ${phone || "N/A"}

Customer notes
--------------
${notes || "None"}

Flight summary
--------------
Price shown to customer: ${flight.price} ${flight.currency}
Stops: ${flight.stops}
Total duration: ${flight.totalDuration}

Layovers
--------
${layoverText}

Baggage
-------
${baggageText}

Segments
--------
${flight.segments.map(
  (s, i) =>
    `${i + 1}. ${s.airline}${s.flightNumber} ${s.from}-${s.to}
Depart: ${s.depart}
Arrive: ${s.arrive}`
).join("\n\n")}
`;

  try {

    await axios.post("https://api.smtp2go.com/v3/email/send", {
      api_key: process.env.SMTP2GO_API_KEY,
      to: [process.env.AGENCY_EMAIL],
      sender: process.env.FROM_EMAIL,
      subject: "New booking request",
      text_body: agencyText
    });

    await axios.post("https://api.smtp2go.com/v3/email/send", {
      api_key: process.env.SMTP2GO_API_KEY,
      to: [email],
      sender: process.env.FROM_EMAIL,
      subject: "We received your booking request",
      text_body:
        "Thank you. Your request was received. Our agency will contact you shortly."
    });

    res.json({ success: true });

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Email failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on", PORT));
