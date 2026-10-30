// Fictional seat layouts, keyed by catalog event slug. Only these events are reserved seating;
// every other tier is general admission with a made-up capacity (see seed.js).

const rows = (labels, perRow, y0, gap = 28, rowGap = 30) =>
  labels.flatMap((label, r) =>
    Array.from({ length: perRow }, (_, i) => ({
      row: label,
      number: i + 1,
      x: Math.round(400 + (i - (perRow - 1) / 2) * gap),
      y: y0 + r * rowGap,
    })),
  );

export const seatedEvents = {
  "blue-lotus-orchestra-mumbai": {
    viewBox: "0 0 800 560",
    stage: { x: 200, y: 20, width: 400, height: 40, label: "STAGE" },
    sections: [
      { name: "Front Stalls", tier: "Front Stalls", seats: rows(["A", "B", "C"], 12, 100) }, // 36
      { name: "Stalls", tier: "Stalls", seats: rows(["D", "E", "F", "G", "H", "I", "J"], 14, 200) }, // 98
      { name: "Balcony", tier: "Balcony", seats: rows(["K", "L", "M"], 22, 440, 32, 30) }, // 66
    ],
  },
  "laugh-riot-delhi": {
    viewBox: "0 0 800 340",
    stage: { x: 250, y: 20, width: 300, height: 36, label: "STAGE" },
    sections: [
      { name: "Premium", tier: "Premium", seats: rows(["A", "B"], 10, 90, 40) }, // 20
      { name: "Standard", tier: "Standard", seats: rows(["C", "D", "E", "F"], 10, 160, 40) }, // 40
    ],
  },
};
