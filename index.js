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

/* ---------------- search flights (IATA ONLY) ---------------- */

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

    const originCode = String(origin).trim().toUpperCase();
    const destinationCode = String(destination).trim().toUpperCase();

    const iataRegex = /^[A-Z]{3}$/;

    if (!iataRegex.test(originCode)) {
      return res.status(400).json({
        error: "Origin must be a 3-letter airport code"
      });
    }

    if (!iataRegex.test(destinationCode)) {
      return res.status(400).json({
        error: "Destination must be a 3-letter airport code"
      });
    }

    const token = await getAmadeusToken();

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

      const itineraries = flight.itineraries || [];

      const segments = itineraries.flatMap((it, legIndex) =>
        (it.segments || []).map(s => ({
          from: s.departure.iataCode,
          to: s.arrival.iataCode,
          depart: s.departure.at,
          arrive: s.arrival.at,
          airline: s.carrierCode,
          flightNumber: s.number,
          duration: s.duration,

          /* ---- added ---- */
          legIndex   // 0 = outbound, 1 = return
        }))
      );

      const stops = itineraries.reduce((sum, it) => {
        return sum + Math.max(0, (it.segments?.length || 0) - 1);
      }, 0);

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
        totalDuration: itineraries[0]?.duration || "",
        stops,
        segments,
        baggage,

        /* ---- added so booking email can show pax counts ---- */
        passengers: {
          adults: Number(adults),
          children: Number(children || 0)
        }
      };
    });

    res.json({
      page,
      total: offers.length,
      results: normalized
    });

  } catch (err) {
    console.error("SEARCH ERROR:", err.response?.data || err.message);

    res.status(err.response?.status || 500).json({
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

  const adults =
    flight.passengers?.adults ?? "N/A";

  const children =
    flight.passengers?.children ?? "N/A";

  let layoverText = "None";

  if (flight.segments && flight.segments.length > 1) {

    let rows = [];

    for (let i = 0; i < flight.segments.length - 1; i++) {

      const a = flight.segments[i];
      const b = flight.segments[i + 1];

      /* ---- FIX: only if same leg (no outbound → return gap) ---- */
      if (a.legIndex !== b.legIndex) continue;

      const arrive = new Date(a.arrive);
      const depart = new Date(b.depart);

      const mins = Math.floor((depart - arrive) / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;

      rows.push(`Layover in ${a.to}: ${h}h ${m}m`);
    }

    if (rows.length) {
      layoverText = rows.join("\n");
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

Passengers
----------
Adults: ${adults}
Children: ${children}

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
