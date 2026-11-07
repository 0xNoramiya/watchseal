/**
 * Generates WatchSeal's underwater UI sounds with the ElevenLabs Sound Effects API and saves them
 * to public/sfx/. The site only plays these static files; nothing calls ElevenLabs at runtime.
 *
 *   npm run generate-sfx
 *
 * Needs ELEVENLABS_API_KEY (npx -y @elevenlabs/cli@latest onboard init stores it in .env.local).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    // file absent: rely on the real environment
  }
}

export const SOUNDS = [
  {
    name: "blub",
    use: "button presses",
    text: "A single soft underwater bubble, one gentle low 'blub', short and rounded, quiet UI click",
    durationSeconds: 0.5,
    promptInfluence: 0.8,
  },
  {
    name: "blublub",
    use: "a new alert arrives",
    text: "Two quick soft underwater bubbles rising one after the other, 'blub blub', light and playful",
    durationSeconds: 0.9,
    promptInfluence: 0.8,
  },
  {
    name: "sonar",
    use: "a verdict comes back critical",
    text: "One clean sonar ping underwater with a soft fading echo, calm and attentive, not an alarm",
    durationSeconds: 1.6,
    promptInfluence: 0.7,
  },
  {
    name: "surface",
    use: "a memory lands on Walrus",
    text: "A small air bubble rising through water and popping gently at the surface, a soft satisfying confirmation",
    durationSeconds: 1.0,
    promptInfluence: 0.75,
  },
] as const;

async function main() {
  const client = new ElevenLabsClient();
  mkdirSync("public/sfx", { recursive: true });
  for (const s of SOUNDS) {
    const audio = await client.textToSoundEffects.convert({
      text: s.text,
      // v3 needs a newer SDK than the pinned 2.74.0; v2 is the API default and suits short UI sounds.
      modelId: "eleven_text_to_sound_v2",
      durationSeconds: s.durationSeconds,
      promptInfluence: s.promptInfluence,
      outputFormat: "mp3_44100_64",
    });
    const chunks: Uint8Array[] = [];
    const reader = audio.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    writeFileSync(`public/sfx/${s.name}.mp3`, bytes);
    console.log(`${s.name}.mp3  ${(bytes.length / 1024).toFixed(1)} KB  (${s.use})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
