import "dotenv/config";

import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

/* -------------------- Health -------------------- */

app.get("/", (req, res) => {
  res.send("Flight search backend running");
});

/* -------------------- Amadeus token -------------------- */

let amadeusToken = null;
let amadeusTokenExpiry = 0;

async function getAmadeusToken() {
  const now = Date.now();

  if (amadeusToken && now < amadeusTokenExpiry) {
    return amadeusToken;
  }

  const response = await axios.post(
    "https://test.api.amadeus.com/v1/security/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    }).toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  amadeusToken = response.data.access_token;
  amadeusTokenExpiry =
    now + response.data.expires_in * 1000 - 60000;

  return amadeusToken;
}

/* -------------------- Search flights (SAR currency) -------------------- */

app.post("/api/search-flights", async (req, res) => {
  try {
    const {
      origin,
      destination,
      date,
      returnDate,
      adults,
      tripType
    } = req.body;

    if (!origin || !destination || !date || !adults) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const token = await getAmadeusToken();

    const params = {
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate: date,
      adults: adults,
      max: 10,

      // 👇 THIS is what makes prices come back in Saudi Riyal
      currencyCode: "SAR"
    };

    if (tripType === "roundtrip" && returnDate) {
      params.returnDate = returnDate;
    }

    const response = await axios.get(
      "https://test.api.amadeus.com/v2/shopping/flight-offers",
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        params
      }
    );

    const normalizedFlights = response.data.data.map((flight) => {
      const segments = flight.itineraries[0].segments;

      return {
        id: flight.id,
        price: flight.price.total,
        currency: flight.price.currency,
        stops: segments.length - 1,
        totalDuration: flight.itineraries[0].duration,
        segments: segments.map((seg) => ({
          from: seg.departure.iataCode,
          to: seg.arrival.iataCode,
          depart: seg.departure.at,
          arrive: seg.arrival.at,
          airline: seg.carrierCode,
          flightNumber: seg.number,
          duration: seg.duration
        }))
      };
    });

    res.json(normalizedFlights);

  } catch (error) {
    console.error(
      "Search error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      error: "Flight search failed",
      details: error.response?.data
    });
  }
});

/* -------------------- Booking request (SMTP2GO HTTP API) -------------------- */

app.post("/api/booking-request", async (req, res) => {
  const { name, email, phone, notes, flight } = req.body;

  if (!name || !email || !flight || !flight.segments) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const textBody = `
New Flight Booking Request

Passenger Name: ${name}
Email: ${email}
Phone: ${phone || "N/A"}

--- FLIGHT DETAILS ---

${flight.segments.map(
  (s, i) =>
    `${i + 1}. ${s.airline}${s.flightNumber}  ${s.from} → ${s.to}
Depart: ${s.depart}
Arrive: ${s.arrive}`
).join("\n\n")}

Displayed price: ${flight.price} ${flight.currency}

Notes from customer:
${notes || "None"}
`;

  try {
    const response = await axios.post(
      "https://api.smtp2go.com/v3/email/send",
      {
        api_key: process.env.SMTP2GO_API_KEY,
        to: [process.env.AGENCY_EMAIL],
        sender: process.env.FROM_EMAIL,
        subject: "New Flight Booking Request",
        text_body: textBody
      },
      { timeout: 10000 }
    );

    if (
      response.data &&
      response.data.data &&
      response.data.data.succeeded > 0
    ) {
      return res.json({ success: true });
    }

    console.error("SMTP2GO API failed:", response.data);
    return res.status(500).json({ error: "Email API failed" });

  } catch (err) {
    console.error(
      "SMTP2GO HTTP error:",
      err.response?.data || err.message
    );

    return res.status(500).json({
      error: "Failed to send booking request"
    });
  }
});

/* -------------------- Start server -------------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
