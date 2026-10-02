# Black and white cat sprites

Each atlas has six equal columns. The renderer displays a cell at 64 ¡Á 64 CSS pixels.
The white cat occupies the left half and the black cat the right half. Independent
layers can select different frames and loop cadences; coordinated high fives use
one complete cell so their crossing paws remain intact.

## Asymmetric scenes

`asymmetric-spritesheet.webp` is a 1536 ¡Á 1024 RGBA atlas with four rows and
24 frames, generated with the built-in imagegen tool and converted losslessly
to WebP with FFmpeg. Its transparent alpha is preserved.

1. White cat grooms a paw; black cat looks aside and blinks.
2. White cat watches; black cat stretches forward.
3. White cat yawns; black cat waves.
4. White cat looks upward; black cat curls up and rises.

Playful loops include these scenes. Classic and varied keep their existing
loop selection. Click and double-click feedback use all four scenes, with two
cadences per scene. Solo cat selection crops the appropriate half.

### Generation prompt

Use case: stylized-concept. Generate a NEW production animation sprite atlas based on the reference cat identities and bold black outline cartoon style. EXACT 1536x1024 canvas, 6 equal columns x4 equal rows, each cell256x256, no grid lines or text. Each cell contains white cat on LEFT within x8..122 and black cat RIGHT within x134..248, both wholly contained in their half, consistent scale and baseline y230 local cell. Real transparent background, no floor, no gray haze, no colored effects. White cat solid white with black outline; black cat entirely solid black including belly paws tail, only eyes nose and short whiskers white, NO white belly stripe or paws. Four six-frame smooth loops, DIFFERENT ACTIONS for the two cats, NOT mirrored. Every row starts and ends with neutral seated cats same sizes as reference. Row1 white cat lifts front paw and licks/grooms it through frames2-5 while black cat stays seated lazily, looks to side then blinks. Row2 white cat remains seated watching black cat; black cat stretches forward with forepaws lowered and rump/tail raised then returns seated. Row3 white cat yawns opening mouth then closes eyes, black cat raises one paw to wave through middle frames, then lowers. Row4 white cat tilts head and looks up inquisitively while black cat curls up to rest then rises. Ensure BOTH cats visible clean silhouettes even on dark backgrounds; no props, no lettering, no accessories. Keep exact evenly spaced cells and character continuity. This is animation production art; six consecutive frames per row, subtle coherent motion, no isolated pose collection.

Reference: `interaction-spritesheet.webp`.
