/**
 * The sound pack every project gets, synthesized with ffmpeg so there is no
 * third-party audio to license: whoosh and swish for transitions, boom for a
 * landing, tick for a counter step, chime for a reveal, riser before a drop.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { ffmpeg } from './tools.mjs'

export const SFX = {
  whoosh: { duration: 0.7, source: 'anoisesrc=d=0.7:c=pink:a=0.8:seed=7', filter: 'bandpass=f=900:width_type=h:w=1400,afade=t=in:d=0.38:curve=exp,afade=t=out:st=0.38:d=0.32,volume=1.6' },
  swish: { duration: 0.45, source: 'anoisesrc=d=0.45:c=white:a=0.6:seed=11', filter: 'highpass=f=2600,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.33' },
  boom: { duration: 0.9, source: "aevalsrc='0.9*sin(2*PI*(95-70*t)*t)*exp(-4.2*t)':d=0.9:s=48000", filter: 'lowpass=f=400' },
  tick: { duration: 0.08, source: "aevalsrc='0.55*sin(2*PI*2300*t)*exp(-70*t)':d=0.08:s=48000", filter: 'anull' },
  chime: { duration: 1.4, source: "aevalsrc='0.32*(sin(2*PI*1320*t)+0.55*sin(2*PI*1980*t)+0.3*sin(2*PI*2640*t))*exp(-3.2*t)':d=1.4:s=48000", filter: 'anull' },
  riser: { duration: 1.2, source: "aevalsrc='0.22*sin(2*PI*(180+520*t)*t)*t':d=1.2:s=48000", filter: 'afade=t=out:st=1.1:d=0.1' },
}

export async function writeSfxPack(dir) {
  await mkdir(dir, { recursive: true })
  for (const [name, sound] of Object.entries(SFX)) {
    await ffmpeg(['-f', 'lavfi', '-i', sound.source, '-af', sound.filter, '-ar', '48000', '-ac', '2', path.join(dir, `${name}.wav`)])
  }
  return Object.keys(SFX)
}
