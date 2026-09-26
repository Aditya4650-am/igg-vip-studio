import { unlockAllAvatars, getExistingAvatars, injectAvatars } from "./src/lib/server/township/inject.server.ts";
import { readFileSync } from "node:fs";

// Read the user's file
const xml = readFileSync("C:\\Users\\User\\Downloads\\mGameInfo.current-7.xml", "utf-8");
console.log("File length:", xml.length);

// Test getExistingAvatars
const existing = getExistingAvatars(xml, 500);
console.log("Existing avatars count:", existing.length);
console.log("First 10:", existing.slice(0, 10));
console.log("Last 10:", existing.slice(-10));
console.log("Max:", Math.max(...existing));

// Test unlockAllAvatars
const result = unlockAllAvatars(xml, 500);
console.log("\nCreated:", result.created.length);
console.log("Updated:", result.updated.length);
console.log("First few created:", result.created.slice(0, 10));

// Check if result has all avatars
const resultExisting = getExistingAvatars(result.xml, 500);
console.log("\nAfter unlockAllAvatars:");
console.log("Total avatars:", resultExisting.length);
console.log("Has all 1-500:", resultExisting.length >= 500);

// Check AvaUnlocked and UnlockedAvatars
const hasAvaUnlocked = result.xml.includes('AvaUnlocked');
const hasUnlockedAvatars = result.xml.includes('UnlockedAvatars');
console.log("\nHas AvaUnlocked:", hasAvaUnlocked);
console.log("Has UnlockedAvatars:", hasUnlockedAvatars);

// Check if all 1-500 are present
const allPresent = Array.from({length: 500}, (_, i) => i + 1).every(id => 
  result.xml.includes(`Unlocked_ava${id}`) && result.xml.includes(`t="b"`)
);
console.log("\nAll 1-500 present:", allPresent);

// Test injectAvatars with select all
const injectResult = injectAvatars(xml, Array.from({length: 500}, (_, i) => String(i + 1)), 500);
console.log("\ninjectAvatars result length:", injectResult.length);
console.log("Has AvaUnlocked:", injectResult.includes('AvaUnlocked'));