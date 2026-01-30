document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("searchForm");
  const resultsDiv = document.getElementById("results");
  const tripTypeSelect = document.getElementById("tripType");
  const returnDateContainer = document.getElementById("returnDateContainer");

  let selectedFlight = null;

  // --- FIXED RETURN DATE VISIBILITY LOGIC ---
  function updateReturnDateVisibility() {
    if (tripTypeSelect.value === "roundtrip") {
      returnDateContainer.classList.remove("hidden");
    } else {
      returnDateContainer.classList.add("hidden");
    }
  }

  tripTypeSelect.addEventListener("change", updateReturnDateVisibility);

  // run once on page load
  updateReturnDateVisibility();
  // ----------------------------------------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    resultsDiv.innerHTML = "Searching flights...";

    const origin = document.getElementById("origin").value.trim().toUpperCase();
    const destination = document.getElementById("destination").value.trim().toUpperCase();
    const date = document.getElementById("date").value;
    const returnDate = document.getElementById("returnDate").value;
    const adults = document.getElementById("adults").value;
    const tripType = tripTypeSelect.value;

    if (origin.length !== 3 || destination.length !== 3) {
      resultsDiv.innerHTML =
        "Please enter valid 3-letter airport or city codes (e.g. JFK, LHR).";
      return;
    }

    const body = {
      origin,
      destination,
      date,
      adults,
      tripType
    };

    if (tripType === "roundtrip") {
      body.returnDate = returnDate;
    }

    const response = await fetch("http://localhost:3000/api/search-flights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const flights = await response.json();
    resultsDiv.innerHTML = "";

    flights.forEach((flight, index) => {
      const div = document.createElement("div");
      div.className = "flight";

      div.innerHTML = `
        <div class="flight-header">
          <div>
            <strong>Option ${index + 1}</strong><br />
            <span class="flight-details">
              Stops: ${flight.stops} · Duration: ${flight.totalDuration}
            </span>
          </div>
          <div class="flight-price">
            ${flight.price} ${flight.currency}
          </div>
        </div>

        <div class="flight-details">
          ${flight.segments.map(s => `
            <div>
              <strong>${s.airline}${s.flightNumber}</strong>
              ${s.from} → ${s.to}<br />
              <small>
                ${new Date(s.depart).toLocaleString()} – 
                ${new Date(s.arrive).toLocaleString()}
              </small>
            </div>
          `).join("")}
        </div>

        <button class="select-btn">Request Booking</button>
      `;

      div.querySelector(".select-btn").addEventListener("click", () => {
        selectedFlight = flight;
        showBookingForm();
      });

      resultsDiv.appendChild(div);
    });
  });

  function showBookingForm() {
    resultsDiv.innerHTML += `
      <div class="card booking-form">
        <h2>Request Booking Assistance</h2>
        <p>
          Our travel agent will confirm availability and contact you to complete the booking.
        </p>

        <label>Full Name</label>
        <input type="text" id="custName" required />

        <label>Email</label>
        <input type="email" id="custEmail" required />

        <label>Phone (optional)</label>
        <input type="text" id="custPhone" />

        <label>Notes (optional)</label>
        <textarea id="custNotes" rows="3"></textarea>

        <button class="primary-btn" id="sendBooking">
          Send Booking Request
        </button>
      </div>
    `;

    document
      .getElementById("sendBooking")
      .addEventListener("click", sendBookingRequest);
  }

  async function sendBookingRequest() {
    if (!selectedFlight) {
      alert("No flight selected.");
      return;
    }

    const name = document.getElementById("custName").value;
    const email = document.getElementById("custEmail").value;
    const phone = document.getElementById("custPhone").value;
    const notes = document.getElementById("custNotes").value;

    if (!name || !email) {
      alert("Name and email are required.");
      return;
    }

    const response = await fetch("http://localhost:3000/api/booking-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone,
        notes,
        flight: selectedFlight
      })
    });

    const result = await response.json();

    if (result.success) {
      alert("Your booking request has been sent. We will contact you shortly.");
    } else {
      alert("Failed to send booking request. Please try again.");
    }
  }
});
