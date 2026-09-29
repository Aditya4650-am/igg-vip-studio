/**
 * Chat sticker ids the sticker feature unlocks (`UnlockedChatEmoji`).
 *
 * Contiguous by construction: `st1..st80`, `sp1..sp29`, `v1..v3`. `st80` was
 * added last because a fetched city and the reference tool both carry it and
 * it completes the run — stopping at 79 left one real sticker unobtainable.
 *
 * The reference tool's own unlock value also carries a token called `desc`,
 * which no save we hold contains and which fits no id family here (`st*` /
 * `sp*` / `v*`); it reads like a config key that leaked into their string, so
 * it is deliberately *not* copied. Writing an id the game does not know is the
 * exact failure mode this list exists to avoid.
 */
export const CHAT_EMOJI_IDS: string[] = ["sp1", "sp4", "sp5", "sp6", "sp7", "sp8", "sp9", "sp11", "sp12", "sp10", "sp15", "sp14", "sp13", "sp17", "sp16", "sp18", "v1", "v2", "v3", "sp21", "sp20", "sp19", "sp22", "sp24", "sp23", "st1", "st3", "st2", "sp25", "sp27", "sp26", "st7", "st11", "st15", "st17", "st23", "st22", "st26", "st25", "st24", "st28", "st27", "st30", "st29", "st32", "st31", "st34", "st35", "st36", "st38", "st37", "st39", "st40", "st41", "st43", "st42", "st44", "st45", "st46", "st47", "st48", "st49", "st50", "st51", "st52", "st53", "st54", "st55", "st56", "st57", "st58", "st59", "st60", "st61", "st62", "st63", "st64", "st65", "st66", "st67", "st68", "st69", "st70", "st71", "st72", "st73", "st74", "st75", "st79", "st80", "st4", "st5", "st6", "st8", "st9", "st10", "st12", "st13", "st14", "st16", "st18", "st19", "st20", "st21", "st33", "st76", "st77", "st78", "sp2", "sp3", "sp28", "sp29"];
