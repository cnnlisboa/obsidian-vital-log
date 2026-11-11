import { describe, it, expect } from 'vitest';
import { App } from './stubs/obsidian';
import { renderCoreTemplate, resolveNote } from '../src/dailyNoteResolver';

const PATH = 'Calendar/Daily/{{YYYY}}/Q{{Q}}/{{YYYY-MM-DD dddd}}';
const nov11 = new Date(2026, 10, 11, 9, 30);

describe('renderCoreTemplate', () => {
  it('fills date, time and title tokens for the given day', () => {
    const out = renderCoreTemplate(
      'date: {{date:YYYY-MM-DD}}\nweek: "[[{{date:YYYY-[W]ww}}]]"\n{{date}} {{time}} {{title}}',
      nov11,
      '2026-11-11 Wednesday'
    );
    expect(out).toContain('date: 2026-11-11');
    expect(out).toMatch(/week: "\[\[2026-W\d\d\]\]"/);
    expect(out).toContain('2026-11-11 09:30 2026-11-11 Wednesday');
  });

  it('leaves Templater syntax alone', () => {
    expect(renderCoreTemplate('<% tp.date.now() %>', nov11, 'x')).toBe('<% tp.date.now() %>');
  });
});

describe('resolveNote with a template', () => {
  it('creates a new note from the template', async () => {
    const app = new App();
    app.vault.create('Templates/Daily.md', '---\ndate: {{date:YYYY-MM-DD}}\ncssclasses:\n  - daily-note\n---\n');
    const file = await resolveNote(app as never, PATH, nov11, 'Templates/Daily');
    expect(file?.path).toBe('Calendar/Daily/2026/Q4/2026-11-11 Wednesday.md');
    expect(app.vault.raw(file!.path)).toBe('---\ndate: 2026-11-11\ncssclasses:\n  - daily-note\n---\n');
  });

  it('falls back to empty frontmatter when the template is missing', async () => {
    const app = new App();
    const file = await resolveNote(app as never, PATH, nov11, 'Templates/Nope.md');
    expect(app.vault.raw(file!.path)).toBe('---\n---\n');
  });

  it('never touches a note that already exists', async () => {
    const app = new App();
    app.vault.create('Templates/Daily.md', 'TEMPLATE');
    app.vault.create('Calendar/Daily/2026/Q4/2026-11-11 Wednesday.md', 'mine');
    const file = await resolveNote(app as never, PATH, nov11, 'Templates/Daily.md');
    expect(app.vault.raw(file!.path)).toBe('mine');
  });
});
