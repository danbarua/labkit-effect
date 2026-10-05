/** The runner owns these facts. Narration cannot move an item or change the player's fate. */
export const maxTurns = 30;
export const grueEnding = "You have been eaten by a Grue.";
export type Room = "house" | "forest" | "clearing" | "cellar" | "gallery" | "vault";
export type Item = "leaflet" | "lantern" | "sword" | "treasure";
export const actionNames = ["look", "inventory", "examine", "move", "take", "drop", "open", "light"] as const;
export type ActionName = typeof actionNames[number];
export type Action =
  | { readonly tool: "look" | "inventory"; readonly input: Record<string, never> }
  | { readonly tool: "move"; readonly input: { readonly direction: string } }
  | { readonly tool: "take" | "drop" | "examine" | "open" | "light"; readonly input: { readonly target: string } };

export interface World {
  readonly turn: number;
  readonly location: Room;
  readonly items: Readonly<Record<Item, Room | "inventory" | "mailbox">>;
  readonly mailboxOpen: boolean;
  readonly trapdoorOpen: boolean;
  readonly lanternOn: boolean;
  readonly fuel: number;
  readonly outcome: "Alive" | "EatenByGrue";
  readonly event: string;
}

const rooms: Readonly<Record<Room, { readonly name: string; readonly dark: boolean; readonly exits: Readonly<Record<string, Room>> }>> = {
  house: { name: "West of the white house", dark: false, exits: { north: "forest" } },
  forest: { name: "Forest path", dark: false, exits: { south: "house", north: "clearing" } },
  clearing: { name: "Clearing with a stone trapdoor", dark: false, exits: { south: "forest", down: "cellar" } },
  cellar: { name: "Damp cellar", dark: true, exits: { up: "clearing", east: "gallery" } },
  gallery: { name: "Underground gallery", dark: true, exits: { west: "cellar", north: "vault" } },
  vault: { name: "Treasure vault", dark: true, exits: { south: "gallery" } },
};
const descriptions: Readonly<Record<string, string>> = {
  leaflet: "WELCOME TO ZORK. Beware the darkness beneath; light keeps the Grue at bay.",
  lantern: "A brass lantern with a limited supply of fuel.",
  sword: "A rusty sword. It cannot save you from a Grue in total darkness.",
  treasure: "An ancient golden chalice. Treasure does not end this expedition.",
  mailbox: "A small mailbox beside the boarded white house.",
  trapdoor: "A stone trapdoor with an iron ring, leading underground.",
};
export const initialWorld = (): World => ({
  turn: 0, location: "house", items: { leaflet: "mailbox", lantern: "forest", sword: "cellar", treasure: "vault" },
  mailboxOpen: false, trapdoorOpen: false, lanternOn: false, fuel: 12, outcome: "Alive",
  event: "You stand beside a white house and a closed mailbox. A path leads north. Dusk approaches.",
});
export const inventory = (world: World): ReadonlyArray<Item> =>
  (Object.keys(world.items) as Array<Item>).filter((item) => world.items[item] === "inventory");
const visibleItems = (world: World): ReadonlyArray<Item> =>
  (Object.keys(world.items) as Array<Item>).filter((item) => world.items[item] === world.location ||
    (item === "leaflet" && world.items[item] === "mailbox" && world.location === "house" && world.mailboxOpen));
const fixtures = (world: World): ReadonlyArray<string> => {
  if (world.location === "house") return ["mailbox"];
  return world.location === "clearing" ? ["trapdoor"] : [];
};
const exits = (world: World) => Object.fromEntries(Object.entries(rooms[world.location].exits).filter(([direction]) =>
  !((direction === "down" || direction === "up") && !world.trapdoorOpen)));
const illuminated = (world: World) => world.lanternOn && world.fuel > 0 &&
  (world.items.lantern === "inventory" || world.items.lantern === world.location);

export const availableTools = (world: World): ReadonlyArray<ActionName> => world.outcome !== "Alive" ? [] : [
  "look", "inventory", "examine", "move",
  ...(visibleItems(world).length > 0 ? ["take" as const] : []),
  ...(inventory(world).length > 0 ? ["drop" as const] : []),
  ...((world.location === "house" && !world.mailboxOpen) || (world.location === "clearing" && !world.trapdoorOpen) ? ["open" as const] : []),
  ...(world.items.lantern === "inventory" && !world.lanternOn && world.fuel > 0 ? ["light" as const] : []),
];

/** A shared, authoritative snapshot, included in both prompts and every successful tool result. */
export const view = (world: World) => ({
  turn: world.turn, location: world.location, description: rooms[world.location].name,
  exits: exits(world), inventory: inventory(world), visibleItems: visibleItems(world), fixtures: fixtures(world),
  mailboxOpen: world.mailboxOpen, trapdoorOpen: world.trapdoorOpen,
  lanternOn: world.lanternOn, lanternFuel: world.fuel,
  dark: world.turn >= maxTurns || (rooms[world.location].dark && !illuminated(world)),
  outcome: world.outcome, event: world.event, availableTools: availableTools(world),
});

const aliases: Readonly<Record<string, string>> = { n: "north", s: "south", e: "east", w: "west", u: "up", d: "down" };
type Changed = { readonly world: World } | { readonly problem: string };
const change = (world: World, action: Action): Changed => {
  const target = "target" in action.input ? action.input.target : "";
  const item = (Object.keys(world.items) as Array<Item>).find((item) => item === target);
  switch (action.tool) {
    case "look": return { world: { ...world, event: `You survey ${rooms[world.location].name}.` } };
    case "inventory": return { world: { ...world, event: `You carry: ${inventory(world).join(", ") || "nothing"}.` } };
    case "move": {
      const direction = aliases[action.input.direction] ?? action.input.direction;
      const destination = exits(world)[direction];
      return destination === undefined ? { problem: "There is no open exit in that direction." } :
        { world: { ...world, location: destination, event: `You travel ${direction} to ${rooms[destination].name}.` } };
    }
    case "examine": return !fixtures(world).includes(target) && (item === undefined || (!visibleItems(world).includes(item) && !inventory(world).includes(item)))
      ? { problem: "That object is not here or in your inventory." }
      : { world: { ...world, event: descriptions[target] ?? target } };
    case "take": return item === undefined || !visibleItems(world).includes(item)
      ? { problem: "You cannot take an item that is not present." }
      : { world: { ...world, items: { ...world.items, [item]: "inventory" }, event: `Taken: ${item}.` } };
    case "drop": return item === undefined || world.items[item] !== "inventory"
      ? { problem: "You do not carry that item." }
      : { world: { ...world, items: { ...world.items, [item]: world.location }, event: `Dropped: ${item}.` } };
    case "open":
      if (target === "mailbox" && world.location === "house" && !world.mailboxOpen)
        return { world: { ...world, mailboxOpen: true, event: "The mailbox opens, revealing a leaflet." } };
      if (target === "trapdoor" && world.location === "clearing" && !world.trapdoorOpen)
        return { world: { ...world, trapdoorOpen: true, event: "The trapdoor opens onto stairs into darkness. A Grue stirs below." } };
      return { problem: "That cannot be opened here." };
    case "light": return target !== "lantern" || world.items.lantern !== "inventory" || world.fuel <= 0 || world.lanternOn
      ? { problem: "You need an unlit lantern with fuel in your inventory." }
      : { world: { ...world, lanternOn: true, event: "The lantern casts a protective circle of light." } };
  }
};

/** One valid action consumes one turn, including looking and checking inventory. */
export const applyAction = (world: World, action: Action): Changed => {
  if (world.outcome !== "Alive") return { problem: "The game has ended." };
  const changed = change(world, action);
  if ("problem" in changed) return changed;
  const turn = world.turn + 1;
  const fuel = Math.max(0, changed.world.fuel - (changed.world.lanternOn ? 1 : 0));
  const next = { ...changed.world, turn, fuel, lanternOn: changed.world.lanternOn && fuel > 0 };
  if (turn >= maxTurns) return { world: { ...next, lanternOn: false, outcome: "EatenByGrue",
    event: `Night falls unnaturally across the world and every light dies. The waiting Grue attacks. ${grueEnding}` } };
  if (rooms[next.location].dark && !illuminated(next)) return { world: { ...next, outcome: "EatenByGrue",
    event: `${next.event} You are alone in total darkness. ${grueEnding}` } };
  return { world: next };
};
