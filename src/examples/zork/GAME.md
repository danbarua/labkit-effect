# Zork

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
