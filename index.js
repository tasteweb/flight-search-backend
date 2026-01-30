import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

import axios from "axios";

let amadeusToken = null;
let amadeusTokenExpiry = 0;

async function getAmadeusToken() {
  if (amadeusToken && Date.now() < amadeusTokenExpiry) {
    return amadeusToken;
  }

  const response = await axios.post(
    "https://test.api.amadeus.com/v1/security/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  amadeusToken = response.data.access_token;
  amadeusTokenExpiry = Date.now() + response.data.expires_in * 1000;

  return amadeusToken;
}

const mailTransporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: 465,
  secure: true, // REQUIRED for port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});



import express from "express";
import cors from "cors";


const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/test-amadeus", async (req, res) => {
  try {
    const token = await getAmadeusToken();
    res.json({ success: true, tokenLength: token.length });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: "Failed to get Amadeus token" });
  }
});

app.post("/api/search-flights", async (req, res) => {
  try {
    const { origin, destination, date, returnDate, adults, tripType } = req.body;


    if (!origin || !destination || !date || !adults) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const token = await getAmadeusToken();

  

const params = {
  originLocationCode: origin,
  destinationLocationCode: destination,
  departureDate: date,
  adults: adults,
  max: 10
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


    const normalizedFlights = response.data.data.map(flight => {
      const itinerary = flight.itineraries[0];
      const segments = itinerary.segments;

      return {
        id: flight.id,
        price: flight.price.total,
        currency: flight.price.currency,
        stops: segments.length - 1,
        totalDuration: itinerary.duration,
        segments: segments.map(seg => ({
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
  console.error("FLIGHT SEARCH ERROR");
  console.error("Message:", error.message);
  console.error("Response data:", error.response?.data);
  console.error("Status:", error.response?.status);
  res.status(500).json({
    error: "Flight search failed",
    details: error.response?.data || error.message
  });
}

});

app.post("/api/booking-request", async (req, res) => {
  try {
    const { flight, name, email, phone, notes } = req.body;

    if (!flight || !name || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }


    const emailText = `
New Flight Booking Request

Passenger Name: ${name}
Email: ${email}
Phone: ${phone || "N/A"}

--- FLIGHT IDENTIFICATION ---
Amadeus Offer ID: ${flight.id}

Search Summary:
Route: ${flight.segments[0].from} → ${flight.segments[flight.segments.length - 1].to}
Stops: ${flight.stops}
Total Duration: ${flight.totalDuration}
Displayed Price: ${flight.price} ${flight.currency}

Segments:
${flight.segments.map((s, i) =>
  `${i + 1}. ${s.airline}${s.flightNumber} | ${s.from} → ${s.to}
     Depart: ${s.depart}
     Arrive: ${s.arrive}`
).join("\n")}

Notes from customer:
${notes || "None"}

IMPORTANT:
- Price is indicative and subject to availability
- Please reprice before ticketing
- Booking requested via website at ${new Date().toISOString()}
`;


    await mailTransporter.sendMail({
      from: `"Flight Requests" <${process.env.FROM_EMAIL}>`,
      to: process.env.AGENCY_EMAIL,
      subject: "New Flight Booking Request",
      text: emailText
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to send booking request" });
  }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
