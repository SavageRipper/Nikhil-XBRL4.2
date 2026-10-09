// v14 UI helper: a one-click remedy for a validation message, where the remedy is unambiguous. The gate and the MCA
// rules decide what is an error; a fix only performs an ordinary edit through the Session (the same path as typing:
// applicability, locks, recalculation), after the user confirms it. Messages without an unambiguous remedy have no fix
// (the message still opens its cell).
//
//   GR-1 a part entered, its total missing        → enter the total = the sum of its parts
//   GR-1 a previous-year opening value w/o total   → remove that opening value (its total has no cell for that date)
//   GR-1 total ≠ Σ parts (total entered)           → set the total to the sum of its parts
//   mandatory amount not present                   → report nil (0)
//   GR-6 previous year entered, current year not   → report nil (0) for the current year (only if it is nil!)
//   statement figure ≠ its note (SR-L555-1 …)      → take the figure from the note
import { statementNoteLinks } from './derived.js';
import * as Dec from './decimal.js';
import { reportingYear } from './periods.js';
import { cellFor, setAside } from './upkeep.js';

const PL = { CY: 'current year', PY: 'previous year' };
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function fixFor(S, issue) {
  if (!issue || issue.severity !== 'ERROR') return null;
  const A = S.A, f = S.filing;
  const fact = issue.factKey ? f.facts.get(issue.factKey) : null;
  const msg = issue.message || '';
  const scopeOfFact = (x) => reportingYear(f.meta.periods, x.period);
  const locked = (sc) => S.pyLocked(sc);
  // a value no tab shows (dated outside the filing's years, or a previous-year opening value without its cell)
  if (issue.location?.kind === 'pyo' && fact) {
    const other = f.scopeOf(fact.period) === 'OTHER';
    return { label: 'Set it aside', confirm: `Set aside <b>${esc(A.label(fact.concept))}</b> dated ${esc(fact.period.date || `${fact.period.start} → ${fact.period.end}`)}? ${other ? "It is outside this filing's two years" : 'No tab shows a cell for it'}; it stays in the project under Hidden data (restorable) and is no longer part of the filing.`, apply: () => setAside(S, [{ fact, reason: other ? 'otherDate' : 'openingNoCell' }], 'fix') };
  }
  // GR-1: part entered, total missing
  if (issue.ruleId === 'GR-1' && fact && /is entered but its calculation parent/.test(msg)) {
    if (f.scopeOf(fact.period) === 'PYO') {
      return { label: 'Remove this opening value', confirm: `Remove the previous-year opening value <b>${esc(A.label(fact.concept))}</b> dated ${fact.period.date}? Its total has no cell for that date; previous-year opening balances are optional.`, apply: () => S.removeFacts([fact]) };
    }
    const sc = scopeOfFact(fact);
    for (const p of S.calcParentsOf(fact.concept, fact.period, fact.dims)) {
      const t = S.totalFromParts(p, fact.period, fact.dims);
      if (!t) continue;
      if (locked(sc)) return { label: 'Enter the total', disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
      return { label: `Enter ${A.label(p)} = sum of parts`, confirm: `Enter <b>${esc(A.label(p))}</b> (${PL[sc]}) as the sum of its parts reported here: <b>${esc(S.displayOf({ concept: p, value: t.value, nil: false }))}</b>.`, apply: () => S.setTotalFromParts(p, fact.period, fact.dims) };
    }
    return null;
  }
  // GR-1: total ≠ Σ parts, the total was entered (a calculated total follows its parts by itself)
  if (issue.ruleId === 'GR-1' && fact && issue.calc && /Calculation inconsistency/.test(msg) && fact.origin !== 'calculated') {
    const t = S.totalFromParts(fact.concept, fact.period, fact.dims);
    if (!t) return null;
    const sc = scopeOfFact(fact);
    if (locked(sc)) return { label: 'Set total = sum of parts', disabled: 'The previous year is locked (last year\'s filed figures) — unlock it first.' };
    return { label: 'Set total = sum of parts', confirm: `Replace <b>${esc(A.label(fact.concept))}</b> (${PL[sc]}) ${esc(S.displayOf(fact))} by the sum of its parts <b>${esc(S.displayOf({ concept: fact.concept, value: t.value, nil: false }))}</b>? Only if the parts are right — otherwise correct the parts.`, apply: () => S.setTotalFromParts(fact.concept, fact.period, fact.dims) };
  }
  // a statement figure that differs from its note (the MCA rule tying them)
  for (const l of statementNoteLinks(A).values()) {
    if (l.kind !== 'sum' || l.ruleId !== issue.ruleId) continue;
    const sc = issue.scope === 'PY' ? 'PY' : 'CY';
    const v = S.noteValue(l, sc);
    const p = f.period(l.concept, sc);
    const x = p && f.get(l.concept, p, []);
    if (!v || v.undetermined || !x) continue;
    if (locked(sc)) return { label: 'Take the figure from the note', disabled: 'The previous year is locked — unlock it first.' };
    return { label: 'Take the figure from the note', confirm: `Set <b>${esc(A.label(l.concept))}</b> (${PL[sc]}) to the note's figure <b>${esc(S.displayOf({ concept: l.concept, value: Dec.toString(v.total), nil: false }))}</b> (now ${esc(S.displayOf(x))})? Only if the note is right — otherwise correct the note.`, apply: () => { f.setFact({ concept: l.concept, period: p, dims: [], value: Dec.toString(v.total), decimals: v.decimals, unit: v.unit || x.unit, origin: 'calculated' }); S.recalcFrom(l.concept, p, [], 0, { before: x.value, after: Dec.toString(v.total) }); } };
  }
  // a mandatory amount not present → nil
  const m = /^'(.+)' is mandatory — not present for (CY|PY)/.exec(msg.replace(/^\[[^\]]+\]\s*/, ''));
  if (m && issue.concept && A.isNumeric(issue.concept)) return nilFix(S, issue.concept, m[2], issue.location);
  // GR-6: previous year entered, current year not → nil for the current year
  if (issue.ruleId === 'GR-6' && fact && A.isNumeric(fact.concept) && /current-year value should be entered/.test(msg)) {
    return nilFix(S, fact.concept, 'CY', null, fact.dims, fact);
  }
  return null;
}

function nilFix(S, concept, scope, loc, dims = [], prevFact = null) {
  const A = S.A;
  if (S.pyLocked(scope)) return { label: 'Report nil (0)', disabled: 'The previous year is locked — unlock it first.' };
  const label = 'Report nil (0)';
  const confirm = `Report <b>${esc(A.label(concept))}</b> as <b>0</b> for the ${PL[scope]}${prevFact ? ` (the previous year reports ${esc(S.displayOf(prevFact))})` : ''}? Only if the amount really is nil — otherwise enter the figure in its cell.`;
  return { label, confirm, apply: () => {
    const period = S.filing.period(concept, scope);
    const t = cellFor(S, { concept, period, dims });
    if (t.why) throw new Error(`No cell for this value: ${t.why}`);
    if (t.kind === 'row') return S.setValue(concept, t.scope, '0', { preferredLabel: t.preferredLabel, tab: t.elrUri, recalc: true });
    return S.setTableValue(t.tableId, t.scope, t.dims, concept, '0', { preferredLabel: t.preferredLabel, recalc: true, lockCalculated: true });
  } };
}
