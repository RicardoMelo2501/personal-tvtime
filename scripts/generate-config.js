const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const OUT_PATH = path.join(ROOT, "config.js");

function parseEnvFile(content) {
  var out = {};
  content.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf("#") === 0) return;
    var idx = trimmed.indexOf("=");
    if (idx === -1) return;
    var key = trimmed.slice(0, idx).trim();
    var value = trimmed.slice(idx + 1).trim();
    if ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'")) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

var envFromFile = {};
if (fs.existsSync(ENV_PATH)) {
  envFromFile = parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"));
  console.log("Lendo credenciais de .env");
} else {
  console.log(".env não encontrado — usando variáveis de ambiente do processo (ex: secrets do GitHub Actions)");
}

var url = envFromFile.SUPABASE_URL || process.env.SUPABASE_URL;
var anonKey = envFromFile.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
var tvdbApiKey = envFromFile.TVDB_API_KEY || process.env.TVDB_API_KEY || "";

if (!url || !anonKey) {
  console.error(
    "Erro: defina SUPABASE_URL e SUPABASE_ANON_KEY em um arquivo .env (veja .env.example) " +
    "ou como variáveis de ambiente / secrets do GitHub Actions."
  );
  process.exit(1);
}

if (!tvdbApiKey) {
  console.log("Aviso: TVDB_API_KEY não definido — capas de séries/filmes via TheTVDB ficarão desativadas.");
}

var output =
  "// Gerado automaticamente por scripts/generate-config.js — não editar à mão, não commitar.\n" +
  "window.SUPABASE_CONFIG = {\n" +
  "  url: " + JSON.stringify(url) + ",\n" +
  "  anonKey: " + JSON.stringify(anonKey) + "\n" +
  "};\n" +
  "window.TVDB_CONFIG = {\n" +
  "  apiKey: " + JSON.stringify(tvdbApiKey) + "\n" +
  "};\n";

fs.writeFileSync(OUT_PATH, output);
console.log("config.js gerado em " + OUT_PATH);
