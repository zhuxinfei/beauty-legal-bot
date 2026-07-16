import sharp from 'sharp';

const [, , input = 'out/decision-map.svg', output = 'out/decision-map.png'] = process.argv;

await sharp(input)
  .png()
  .toFile(output);

console.log(`Generated ${output}`);
