/**
 * An Agent's avatar key, stored with the Agent in TeamHub:
 * - `figure:<name>:RRGGBB` shows the named animal character on that background;
 * - `image:RRGGBB` shows the uploaded image on that background.
 * Any other key resolves to a character derived from the Agent, on that
 * character's own background.
 */
export type AgentAvatarKey = string;

/**
 * The animal characters in gallery order, each with the background it was
 * drawn on. Those pairings are the defaults; a palette can recolor any of them.
 * The name is the asset file stem and is what TeamHub stores in the key. Kept
 * as one string because this module is on the initial JavaScript graph.
 */
const AGENT_FIGURES = `
  cat:151111 dog:5A8F66 rabbit:1C1921 fox:6A5C4B bear:3E988D panda:A1A572
  koala:9E964A raccoon:43A46A red_panda:CAABD8 hamster:6C986D squirrel:6559B1
  chipmunk:735848 hedgehog:72AC90 mouse:553760 guinea_pig:161410
  chinchilla:141A1E ferret:AA4BA1 otter:BCD8AB beaver:ABCED8 capybara:865658
  lion:C3E3C6 tiger:8F6EAF leopard:736D4E cheetah:589898 wolf:A74E64
  arctic_fox:719158 fennec:3F3D5A lynx:AB6683 elephant:556D59 giraffe:6E5D92
  zebra:B65B6D rhino:161B1A hippo:221722 deer:485233 moose:3477C4 goat:61424B
  sheep:131812 cow:6B77B2 pig:A8876F horse:4E90B5 donkey:9E5BAE alpaca:7A7B41
  camel:4B7B90 kangaroo:AB5E88 wombat:61744E sloth:4E508E monkey:C434AD
  lemur:141A16 meerkat:7549AD bat:E3D2C3 penguin:B7DECE owl:E3C3D8
  chick:879A69 duck:3A3F51 goose:67363C swan:5F9170 parrot:D2ABD8
  toucan:61A99C flamingo:6E9589 peacock:DEB7BE sparrow:244059 robin:384559
  bluebird:B73161 cockatiel:6E935C puffin:BFB7DE eagle:2E211F
  woodpecker:51B048 ostrich:75508B kiwi:A15D47 crane:5687B4 seal:583F4E
  sea_lion:C5D8AB walrus:16171F dolphin:A95F5A orca:A3B06E hen:523568
  humpback:B79931 shark:31605D stingray:613C59 sea_turtle:9F4E43
  goldfish:5A6E95 clownfish:69A7B5 pufferfish:384D37 seahorse:3E325F
  octopus:81983E squid:345146 jellyfish:553958 crab:171812 lobster:3331B7
  starfish:24191E frog:C45F34 salamander:C3CCE3 axolotl:78AE70
  crocodile:3C4F45 chameleon:A747A9 gecko:A68656 snake:335458 snail:885379
  butterfly:7BAE69 ladybug:ABD6D8 quokka:315DB9 tapir:7CB174 platypus:DDB5CA
  echidna:35A9C6 pangolin:4E7E95 armadillo:AB2E33 anteater:C9E2C1
  tarsier:E2C1E2 sugar_glider:AC655F jerboa:636E9B pika:7B65B3
  binturong:CBD8A9 okapi:477EAA bison:B04EA4 yak:6C5EB4 musk_ox:66ACA0
  bushbaby:1D1816 manatee:1A2324 narwhal:A49D4D nautilus:66977E
  dumbo_octopus:629574 bee:C1A9D8 moth:316260 dragonfly:AD6A85
  leaf_insect:7F5146 alien_mint:7A5390 alien_cyclops:2C1E20
  alien_three_eye:475341 alien_antenna:8A9D6E jelly_alien:A2A552
  onehorn_monster:3C5E40 furry_monster:4F4164 friendly_ghost:AA957B
  baby_dragon:364F63 unicorn:63434C qilin:211F15 slime:845891
  mushroom_sprite:548F54 sprout_sprite:19211E cloud_sprite:614765
  raindrop_sprite:B96D31 star_sprite:3C3F64 moon_sprite:753D61
  flame_sprite:3F9A80 yeti:1D2126 pebble_sprite:544A33 cactus_sprite:AF559A
  coral_sprite:B5DDBF robot_buddy:4E513C mochi_sprite:889D74
`
  .trim()
  .split(/\s+/)
  .map((entry) => entry.split(":") as [string, string]);

export type AgentFigure = string;

export const AGENT_FIGURE_NAMES: readonly AgentFigure[] = AGENT_FIGURES.map(
  ([name]) => name,
);

const figureBackgrounds = new Map(AGENT_FIGURES);

export function figureKey(figure: AgentFigure, color?: string): AgentAvatarKey {
  return `figure:${figure}:${normalizeHex(color ?? figureBackgrounds.get(figure)!)}`;
}

export function imageKey(color: string): AgentAvatarKey {
  return `image:${normalizeHex(color)}`;
}

/** Every character on its drawn background, for pickers and seeded defaults. */
export const AGENT_AVATAR_KEYS: readonly AgentAvatarKey[] =
  AGENT_FIGURE_NAMES.map((figure) => figureKey(figure));

function isAgentFigure(value: string): value is AgentFigure {
  return figureBackgrounds.has(value);
}

export function isAgentAvatarKey(value: string): value is AgentAvatarKey {
  const figure = /^figure:([a-z_]+):[0-9a-fA-F]{6}$/.exec(value);
  if (figure) return isAgentFigure(figure[1]!);
  return /^image:[0-9a-fA-F]{6}$/.test(value);
}

/** How a key renders: a character or an uploaded image, on a background. */
export function agentAvatarAppearance(key: AgentAvatarKey): {
  color: string;
  figure: AgentFigure;
  kind: "figure" | "image";
} {
  const [scheme, first = "", second = ""] = key.split(":");
  if (scheme === "image" && /^[0-9a-fA-F]{6}$/.test(first)) {
    return {
      color: `#${first.toUpperCase()}`,
      figure: AGENT_FIGURE_NAMES[0]!,
      kind: "image",
    };
  }
  if (
    scheme === "figure" &&
    isAgentFigure(first) &&
    /^[0-9a-fA-F]{6}$/.test(second)
  ) {
    return { color: `#${second.toUpperCase()}`, figure: first, kind: "figure" };
  }
  // An unknown key still gets a stable character of its own.
  return agentAvatarAppearance(avatarKeyFromSeed(key));
}

export function avatarKeyFromSeed(seed: string): AgentAvatarKey {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return AGENT_AVATAR_KEYS[hash % AGENT_AVATAR_KEYS.length]!;
}

/** A new Agent draws one of the characters at random, on its own background. */
export function randomAgentAvatarKey(): AgentAvatarKey {
  return AGENT_AVATAR_KEYS[
    Math.floor(Math.random() * AGENT_AVATAR_KEYS.length)
  ]!;
}

const AVATAR_STORAGE_KEY = "linger.agent-avatar-keys";

export function readStoredAgentAvatarKey(
  actorId: string,
): AgentAvatarKey | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = readAvatarMap()[actorId];
    return typeof value === "string" && isAgentAvatarKey(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function storeAgentAvatarKey(
  actorId: string,
  avatarKey: AgentAvatarKey,
) {
  if (typeof window === "undefined") return;
  try {
    const parsed = readAvatarMap();
    parsed[actorId] = avatarKey;
    window.localStorage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Avatar persistence is a visual preference, not an authority.
  }
}

function readAvatarMap(): Record<string, string> {
  const raw = window.localStorage.getItem(AVATAR_STORAGE_KEY);
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, string>)
    : {};
}

/**
 * The key an Agent renders with: the caller's, then TeamHub's record, then
 * this browser's last choice, then one derived from the Agent's identity.
 * Unknown keys are skipped so the Agent's own identity picks its character.
 */
export function resolveAgentAvatarKey({
  actorId,
  avatarKey,
  name,
  storedKey,
}: {
  actorId?: string;
  avatarKey?: string;
  name: string;
  storedKey?: string;
}): AgentAvatarKey {
  if (avatarKey && isAgentAvatarKey(avatarKey)) return avatarKey;
  if (storedKey && isAgentAvatarKey(storedKey)) return storedKey;
  if (actorId) {
    const stored = readStoredAgentAvatarKey(actorId);
    if (stored) return stored;
    return avatarKeyFromSeed(actorId);
  }
  return avatarKeyFromSeed(name.trim() || "agent");
}

function normalizeHex(color: string) {
  const hex = color.replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? hex : AGENT_FIGURES[0]![1];
}
