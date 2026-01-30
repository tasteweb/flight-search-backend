import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

/* ---------------- Health ---------------- */

app.get("/", (req, res) => {
  res.send("Backend running");
});

/* ---------------- Amadeus token ---------------- */

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
  if (input.length === 3) return input.toUpperCase();

  const res = await axios.get(
    "https://test.api.amadeus.com/v1/reference-data/locations",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        keyword: input,
        subType: "AIRPORT,CITY"
      }
    }
  );

  const firstAirport = res.data.data.find(
    l => l.subType === "AIRPORT"
  );

  if (!firstAirport) throw new Error("Location not found");

  return firstAirport.iataCode;
}

/* ---------------- Search flights ---------------- */

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

    const token = await getAmadeusToken();

    const originCode = await resolveLocation(origin, token);
    const destinationCode = await resolveLocation(destination, token);

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

    const offers = response.data.data || [];

    const pageSize = 10;
    const start = (page - 1) * pageSize;
    const slice = offers.slice(start, start + pageSize);

    const normalized = slice.map((flight) => {
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

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Flight search failed" });
  }
});

/* ---------------- Booking request + customer email ---------------- */

app.post("/api/booking-request", async (req, res) => {
  const { name, email, phone, notes, flight } = req.body;

  if (!name || !email || !flight) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const agencyText = `
New booking request

Name: ${name}
Email: ${email}
Phone: ${phone || ""}

Price: ${flight.price} ${flight.currency}

Segments:
${flight.segments.map(
  (s, i) =>
    `${i + 1}. ${s.airline}${s.flightNumber} ${s.from}-${s.to}
${s.depart} -> ${s.arrive}`
).join("\n")}
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
