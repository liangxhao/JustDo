"""Read pet atlas alpha and generate CSS clipping boundaries; never modify art.

Requires Pillow. Run from the repository root after replacing a pet atlas.
Coordinated high-five frames are rendered whole by the application.
"""

import json
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'resources/pets/black-white-cats'


def simplify(points, tolerance=0.3):
    if len(points) < 3:
        return points
    x1, y1 = points[0]
    x2, y2 = points[-1]
    distances = [abs(x - (x1 + (x2 - x1) * (y - y1) / (y2 - y1)))
                 for x, y in points[1:-1]]
    largest = max(distances)
    if largest <= tolerance:
        return [points[0], points[-1]]
    index = distances.index(largest) + 1
    return simplify(points[:index + 1])[:-1] + simplify(points[index:])


def boundary(alpha):
    size = alpha.width
    pixels = alpha.load()
    candidates = range(round(size * 0.4), round(size * 0.68))
    # Stay in the transparent gap, including a margin for browser resampling.
    def cost(x, y):
        opacity = max(pixels[xx, y] for xx in range(x - 2, x + 3))
        return max(0, opacity - 16) * 100 + abs(x - size * 0.52) * 0.05

    previous = {x: cost(x, 0) for x in candidates}
    parents = []
    for y in range(1, size):
        current = {}
        row = {}
        for x in candidates:
            source = min((xx for xx in range(x - 1, x + 2) if xx in previous),
                         key=lambda xx: previous[xx] + abs(xx - x) * 0.8)
            current[x] = previous[source] + abs(source - x) * 0.8 + cost(x, y)
            row[x] = source
        parents.append(row)
        previous = current
    x = min(previous, key=previous.get)
    points = [(x, size)]
    for y in range(size - 1, 0, -1):
        points.append((x, y))
        x = parents[y - 1][x]
    points.append((x, 0))
    return simplify(list(reversed(points)))


result = {}
for name in ('spritesheet.png', 'extra-spritesheet.webp', 'reaction-spritesheet.webp',
             'interaction-spritesheet.webp', 'asymmetric-spritesheet.webp'):
    alpha = Image.open(ASSETS / name).getchannel('A')
    size = alpha.width // 6
    frames = []
    for index in range(6 * (alpha.height // size)):
        left, top = index % 6 * size, index // 6 * size
        cell = alpha.crop((left, top, left + size, top + size))
        seam = boundary(cell)
        frames.append([[round(x / size * 100, 3), round(y / size * 100, 3)]
                       for x, y in seam])
    result[name] = frames

(ASSETS / 'sprite-clips.json').write_text(json.dumps(result, separators=(',', ':')) + '\n', encoding='utf-8')
print('Generated per-frame clipping boundaries for', sum(map(len, result.values())), 'frames')
