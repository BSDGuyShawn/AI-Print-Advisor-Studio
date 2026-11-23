// Filament length compared with everyday things ("≈ the length of a school bus"), from the Home Assistant
// print_finished.yaml automation (via U1 Studio's web/js/derive.js). Used in the finished email.
const PRINT_OBJ = [[0.15, "the length of a smartphone"], [0.3, "the length of a school ruler"], [0.55, "the height of a carry-on suitcase"],
  [0.86, "the length of a baseball bat"], [1.0, "the length of an acoustic guitar"], [1.8, "the height of a tall person"],
  [2.0, "the length of a king-size bed"], [2.4, "the height of a giraffe's neck"], [3.05, "the height of a basketball hoop"],
  [4.7, "the length of a family car"], [10.7, "the length of a school bus"], [12.2, "the length of a shipping container"],
  [18.3, "the length of a bowling lane"], [23.8, "the length of a tennis court"], [27.0, "the length of a blue whale"],
  [39.5, "the length of a Boeing 737"], [50.0, "the length of an Olympic swimming pool"], [70.7, "the length of a Boeing 747"],
  [91.4, "a football field, goal line to goal line"], [93.0, "the height of the Statue of Liberty"],
  [109.7, "the length of a football field, end zone to end zone"], [146.6, "the height of the Great Pyramid of Giza"],
  [169.0, "the height of the Washington Monument"], [330.0, "the height of the Eiffel Tower"], [381.0, "the height of the Empire State Building"],
  [508.0, "the height of Taipei 101"], [828.0, "the height of the Burj Khalifa"], [1000.0, "one kilometer"], [1609.0, "one mile"],
  [2737.0, "the length of the Golden Gate Bridge"], [5000.0, "a 5K race"], [8849.0, "the height of Mount Everest"],
  [10000.0, "a 10K race"], [21097.0, "a half marathon"], [42195.0, "a full marathon"]];

function compare(metres, list = PRINT_OBJ) {
  if (!(metres > 0)) return "Nothing extruded yet";
  let best = null;
  for (const o of list) if (metres >= o[0]) best = o;
  if (!best) return `Just getting started, still shorter than ${list[0][1].replace(/^the /, "a ")}`;
  const r = metres / best[0];
  if (r < 1.25) return `≈ ${best[1]}!`;
  return `≈ ${r < 10 ? r.toFixed(1) : Math.round(r)}× ${best[1]}!`;
}

module.exports = { compare };
