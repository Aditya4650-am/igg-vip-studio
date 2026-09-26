import { writeVar } from "./src/lib/server/township/vars.server.ts";

const xml = '<Global><Var name="Unlocked_ava5" v="0" t="b"/></Global>';
const result = writeVar(xml, 'Unlocked_ava5', '1');
console.log('Input:', xml);
console.log('Output:', result);
console.log('Has t=b:', result.includes('t="b"'));

// Test multiple avatars
const xml2 = '<Global><Var name="Unlocked_ava1" v="0" t="b"/><Var name="Unlocked_ava2" v="0" t="b"/></Global>';
const result2 = writeVar(xml2, 'Unlocked_ava1', '1');
console.log('\nInput2:', xml2);
console.log('Output2:', result2);
console.log('Has t=b:', result2.includes('t="b"'));