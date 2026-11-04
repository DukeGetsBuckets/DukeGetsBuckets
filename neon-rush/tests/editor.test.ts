import { describe, it, expect } from 'vitest';
import { TEMPLATES, templatePlacements, definitionFromDraft } from '../src/game/editor/editorModel';
import { driveTrack } from './botHarness';
describe('tmp', () => {
  for (const t of TEMPLATES) it('drive ' + t.id, async () => {
    const r = await driveTrack(definitionFromDraft({ name: t.name, theme: t.theme, placements: templatePlacements(t) }), { log: true });
    console.log(t.id, JSON.stringify(r));
  });
});
