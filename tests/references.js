// Garde-fou : toute fonction locale appelée doit être définie dans son module.
// Un remplacement de bloc un peu large peut emporter une définition sans que la
// syntaxe s'en plaigne — c'est arrivé, ça ne doit pas repasser inaperçu.
const fs = require("fs");
const path = require("path");
const RACINE = path.resolve(__dirname, "..");

// Sans argument, tous les modules du dossier js/.
const FICHIERS = process.argv.length > 2
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(RACINE, "js"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(RACINE, "js", f));
const GLOBAUX = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "parseInt", "parseFloat", "isNaN", "confirm", "alert", "prompt",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "require", "fetch", "encodeURIComponent", "decodeURIComponent", "escape", "unescape",
]);

let echecs = 0;
for (const f of FICHIERS) {
  const src = fs.readFileSync(f, "utf8");
  const defs = new Set([...src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const vars = new Set([...src.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const params = new Set(
    [...src.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean))
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
  const appels = new Set([...code.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]));
  // Les chaînes concaténées du rendu HTML contiennent des mots français suivis
  // d'une parenthèse — « réglages (⚙️) », « 3 adresse(s) ». Le découpage naïf
  // des chaînes en laisse passer ; on ne retient donc que les noms écrits en
  // camelCase, forme de toutes les fonctions du projet.
  const manquants = [...appels].filter(
    (n) => /[a-z][A-Z]/.test(n) &&
      !defs.has(n) && !vars.has(n) && !params.has(n) && !GLOBAUX.has(n)
  );
  if (manquants.length) {
    echecs++;
    console.log("  ECHEC " + path.relative(RACINE, f) + " appelle sans définir : " + manquants.join(", "));
  } else {
    console.log("  OK    " + path.relative(RACINE, f) + " (" + defs.size + " fonctions)");
  }
}
console.log(echecs === 0 ? "\nTOUTES LES RÉFÉRENCES SONT RÉSOLUES" : "\n" + echecs + " FICHIER(S) EN DÉFAUT");
process.exit(echecs === 0 ? 0 : 1);
