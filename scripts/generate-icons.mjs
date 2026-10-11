import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Resolve the image processor supplied by Next.js, including nested installs.
const requireFromNext = createRequire(import.meta.resolve("next/package.json"))
const sharp = requireFromNext("sharp")
const root = new URL("../", import.meta.url)
const source = await readFile(new URL("public/icons/nextmail.svg", root))

function render(size) {
  return sharp(source, { density: Math.max(96, size * 3) }).resize(size, size).png()
}

async function savePng(name, size, plated = false) {
  let icon = render(size)
  if (plated) {
    // Keep the entire mark inside the central maskable safe circle (radius 40%).
    const inset = await render(Math.round(size * 0.7)).toBuffer()
    icon = sharp({
      create: { width: size, height: size, channels: 4, background: "#F3F7FC" },
    }).composite([{ input: inset, gravity: "centre" }]).png()
  }
  await icon.toFile(fileURLToPath(new URL(`public/icons/${name}`, root)))
  console.log(`Generated ${name} (${size}x${size})`)
}

for (const size of [192, 512]) {
  await savePng(`icon-${size}x${size}.png`, size)
  await savePng(`icon-maskable-${size}x${size}.png`, size, true)
}
await savePng("apple-touch-icon.png", 180, true)

// ICO directory with PNG frames: browsers choose the nearest physical size.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = await Promise.all(sizes.map(size => render(size).toBuffer()))
const directory = Buffer.alloc(6 + 16 * sizes.length)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
frames.forEach((frame, index) => {
  const entry = 6 + 16 * index
  directory[entry] = sizes[index] === 256 ? 0 : sizes[index]
  directory[entry + 1] = directory[entry]
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(frame.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += frame.length
})
await writeFile(new URL("app/favicon.ico", root), Buffer.concat([directory, ...frames]))
console.log(`Generated favicon.ico (${sizes.join(", ")}px)`)
