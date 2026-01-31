import "dotenv/config";
import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("Backend running"));

/* ---------------- TOKEN ---------------- */

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

/* ---------------- LOCATION CACHE ---------------- */

const locationCache = new Map();

async function resolveLocation(input, token) {

  const key = input.trim().toLowerCase();

  if (locationCache.has(key)) {
    return locationCache.get(key);
  }

  if (/^[a-zA-Z]{3}$/.test(input.trim())) {
    const code = input.trim().toUpperCase();
    locationCache.set(key, code);
    return code;
  }

  const res = await axios.get(
    "https://test.api.amadeus.com/v1/reference-data/locations",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        keyword: input,
        subType: "AIRPORT,CITY",
        page: { limit: 10 }
      }
    }
  );

  const data = res.data?.data || [];

  const airport = data.find(l => l.subType === "AIRPORT");
  const city = data.find(l => l.subType === "CITY");

  const result = airport?.iataCode || city?.iataCode || null;

  if (result) locationCache.set(key, result);

  return result;
}

/* ---------------- AUTOCOMPLETE API ---------------- */

app.get("/api/locations", async (req, res) => {
  try {

    const q = req.query.q;
    if (!q || q.length < 2) return res.json([]);

    const token = await getAmadeusToken();

    const r = await axios.get(
      "https://test.api.amadeus.com/v1/reference-data/locations",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          keyword: q,
          subType: "AIRPORT,CITY",
          page: { limit: 6 }
        }
      }
    );

    const out = (r.data.data || []).map(l => ({
      name: l.name,
      code: l.iataCode,
      type: l.subType
    }));

    res.json(out);

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.json([]);
  }
});

/* ---------------- SEARCH ---------------- */

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

    if (!originCode)
      return res.status(400).json({ error: "Origin location not found" });

    if (!destinationCode)
      return res.status(400).json({ error: "Destination location not found" });

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

    const r = await axios.get(
      "https://test.api.amadeus.com/v2/shopping/flight-offers",
      {
        headers: { Authorization: `Bearer ${token}` },
        params
      }
    );

    const offers = r.data?.data || [];

    const pageSize = 10;
    const start = (page - 1) * pageSize;

    const slice = offers.slice(start, start + pageSize);

    const results = slice.map(f => {
      const it = f.itineraries[0];
      const segs = it.segments;

      const baggage =
        f.travelerPricings?.[0]?.fareDetailsBySegment?.map(x => ({
          checkedBags: x.includedCheckedBags?.quantity ?? 0,
          cabinBags: x.includedCabinBags?.quantity ?? 0
        })) || [];

      return {
        id: f.id,
        price: f.price.grandTotal,
        currency: f.price.currency,
        totalDuration: it.duration,
        stops: segs.length - 1,
        segments: segs.map(s => ({
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

    res.json({ page, total: offers.length, results });

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Flight search failed" });
  }
});

/* ---------------- BOOKING ---------------- */

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

Price: ${flight.price}

${flight.segments.map(
    s => `${s.airline}${s.flightNumber} ${s.from}-${s.to}`
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
      subject: "Booking request received",
      text_body:
        "Thank you. Your booking request was received. Our agency will contact you shortly."
    });

    res.json({ success: true });

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "Email failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on", PORT));
