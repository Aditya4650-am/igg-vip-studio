import { injectAvatars } from "./src/lib/server/township/inject.server.ts";

const xml = '<Global><Var name="Unlocked_ava5" v="0" t="b"/><Var name="Unlocked_ava10" v="0" t="b"/></Global>';

// Test: select avatars 5, 10 (existing), 15, 20 (new)
const result = injectAvatars(xml, ["5", "10", "15", "20"], 398);
console.log('Input:', xml);
console.log('Output:', result);

// Check all expected avatars are present with t="b"
const expected = ["Unlocked_ava5", "Unlocked_ava10", "Unlocked_ava15", "Unlocked_ava20"];
for (const name of expected) {
  const hasVar = result.includes(`name="${name}"`);
  const hasTb = result.includes(`name="${name}"`) && result.split(`name="${name}"`)[1]?.startsWith(' v="1" t="b"');
  console.log(`${name}: present=${hasVar}, t="b"=${hasTb}`);
}