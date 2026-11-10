# Flights, trains and trips

A trip is one Tracking Item; its checks and reminders are separate Routines. These are typical shapes, not fixed rules: choose times from the actual schedule and what the Human said.

## Routines it usually needs

- **Status check** (purpose like "poll flight status"): start a few hours before departure, then check again as departure nears. Search the web for the live status by flight or train number on the carrier's or a flight-tracking site. Stop after departure or once it has left.
- **Check-in or leave reminder** (purpose like "check-in reminder"): when online check-in opens or when the Human should leave for the airport or station, accounting for distance if known.
- After arrival nothing is needed unless the Human asked (a pickup, a hotel check-in).

## When to tell

- A delay, a gate or platform change, a cancellation, a schedule change: tell at once with the new time and the source, and what it means ("the gate moved to B12" / "now departing about 1 h 20 min late, so the 16:40 meeting in Shanghai cannot be made").
- Check-in opens, or it is time to leave: one short reminder.
- On time and nothing changed: say nothing.

## When things change

- A delay moves the departure: move the check-in or leave reminder and the next status checks to fit the new time.
- A cancellation: tell the Human, mark nothing done, and stop status checks until they rebook; record the rebooked flight as an update to the same item.
- The Human cancels the trip or says "no need": delete the trip's Routines and mark the item done.
