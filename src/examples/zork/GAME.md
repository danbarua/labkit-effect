# Zork

## This example's world

The runner owns location, inventory, item locations, open containers and exits,
lantern fuel, and survival. Treat its world snapshots and tool results as facts;
descriptive prose cannot change them.

The white house leads north to a forest path, then north to a clearing. Opening
the clearing's trapdoor reveals stairs down to a cellar. From the cellar, east
leads to a gallery and north from the gallery leads to a treasure vault. Return
routes are available. Underground rooms are dark: bring a lit lantern.

The mailbox at the house contains a leaflet. The forest has a lantern, the cellar
has a sword, and the vault has treasure. Items must be present to take them, and
must be in inventory to drop them. Dropped items stay where they were dropped.
The lantern has 12 turns of fuel, consumed on each action while lit. A dropped
lit lantern illuminates only its own room.

The Game Engine selects the Adventurer's tools for each turn. Only offered tools
can act: `look`, `inventory`, `examine`, `move`, `take`, `drop`, `open`, `light`.
Use object IDs from the snapshot as `target`, and open exits as `direction`.
One successful tool call is one turn; narration and rejected calls do not advance
time. A round lasts at most **30 turns**. Save, restore, restart and quit are not
implemented and cannot reset the world or its turn count.

The commands below describe the original games. In this example, use the offered
tool schemas for the supported subset instead of free-text commands.

## Commands

In the Zork games, the player is not limited to verb-noun commands, such as "take lamp", "open mailbox", 
and so forth. Instead, the parser supports more sophisticated sentences such as "put the lamp and sword 
in the case", "look under the rug", and "drop all except lantern". The game understands a good number of 
common verbs, including "take", "drop", "examine", "attack", "climb", "open", "close", "count", 
and many more. The games also support commands to the game (rather than in the game) such as "save" and 
"restore", "script" and "unscript" (which begin and end a text transcript of the game text), "restart", 
and "quit".

In all of the Zork text adventures, the following commands apply:

> n, s, e, w

Short for "go north", "go south", etc.
> nw, ne, sw, se

Short for "go northwest", "go southwest", etc.
> u and d

Short for "go up" and "go down"
> i

Reveals a player's inventory
> verbose

Gives full descriptions after each command (rather than omitting details already given to the player)
> score

Displays the player's current score, number of moves, and ranking
