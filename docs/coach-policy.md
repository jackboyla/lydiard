# Deterministic Lydiard coaching policy

This is the stable decision policy behind the Lydiard coach. The platform calculates the physiology, load, plan, and adaptation. An AI agent explains those decisions without bypassing their constraints.

## Philosophy

Build the largest aerobic and mechanical foundation the runner can consistently absorb, then layer hills, anaerobic development, and race coordination without losing that foundation.

- Make aerobic development the base of every phase.
- Progress only training that is being absorbed.
- Treat recovery as training and durability as a capacity to develop.
- Preserve relaxed speed and strides during aerobic development.
- Preserve twice-weekly strength where practical, but account for lower-body gym placement.
- Separate cardiovascular readiness from knee, Achilles, lower-leg, and general mechanical tolerance.
- Do not prescribe a historical 160 km week merely because it carries the Lydiard name.
- Do not cram a missed run into the remaining days.
- Do not raise volume and intensity together after one good run.

## Evidence order

Prefer evidence in this order:

1. Valid recent races or explicit time trials.
2. Reliable best-effort segments from power, HR, and pace streams.
3. Repeated controlled workouts with known recoveries.
4. Stable aerobic and long runs.
5. Long-term personal patterns.
6. Subjective feedback and symptoms.
7. Population formulas as low-confidence priors only.

Record effective dates, model versions, device provenance, evidence activity IDs, and confidence. Do not let one anomalous activity move a threshold sharply.

## Physiology

Model two underlying boundaries and three domains:

- LT1/aerobic threshold: below it is the moderate domain.
- LT1 to LT2/critical speed: the heavy domain.
- Above LT2/critical speed: the severe domain.

Expose five practical training zones: Recovery, Aerobic, Steady, Threshold, and VO2/anaerobic.

Estimate critical speed from credible 3–6, 8–15, and 20–40 minute stream efforts using `distance = CS × time + D′`. Estimate platform Critical Power similarly with `work = CP × time + W′`, while retaining a current, adequately supported Stryd CP as canonical. Infer LT2 HR from sustained work near CP/CS after HR stabilizes. Infer LT1 as a band from repeated controlled runs with personally normal drift and recovery.

## Load and response

Compute stream-backed Lydiard Power Stress as:

```text
LPS = 100 / 3600 × Σ((power / effective_CP)² × sample_seconds)
```

One hour at CP therefore equals 100 LPS. Score every activity against the CP record effective on its date. Use pace/GAP load only as a labelled fallback when valid power is absent; never add a full power load and full GAP load together.

Use HR to assess internal cost. Compare observed HR with the runner's personal HR at comparable %CP, duration, terrain, and run type. Treat raised HR cost, drift at stable power, falling power with stable/rising HR, and reduced power at a standard HR as response signals—not a second load to average into LPS.

Report fitness separately as:

- 42-day training-load fitness;
- aerobic efficiency at a standard HR;
- threshold fitness (CP, CS, threshold HR/GAP);
- race fitness across 3–30 minute efforts;
- durability late in runs and late in the week.

Report fatigue in two layers:

- background: 7/42-day power stress, hard stress, long-run dose, consecutive days, duration, and gym placement;
- observed: HR cost, drift, pace/power deterioration, feedback, pain, and leg condition.

A normal load balance must not overrule worsening symptoms or collapsing efficiency.

## Phase policy

### Aerobic conditioning and durability

Build repeatable duration, aerobic efficiency, long-run tolerance, strength, and connective-tissue capacity. Use frequent easy/aerobic running, one long run, one medium-long run, controlled steady running only when ready, strides, short relaxed hills, and strength. Avoid substantial glycolytic work until the surrounding volume is absorbed.

### Hill resistance and strength transition

Maintain most aerobic volume while adding a conservative, short hill block for force, elasticity, form, and preparation for faster work. Protect the Achilles and knees.

### Anaerobic and race-specific development

Add a limited block of threshold/10K support, 5K-specific work, VO2 work, and relaxed faster repetitions. Usually cap consequential quality at two sessions per week and maintain the long run and aerobic mileage.

### Coordination and sharpening

Reduce total load while increasing specificity. Use controlled race-pace rehearsal, short races/time trials, sharpening repetitions, full recovery, and pacing practice.

### Recovery and regeneration

Reduce load deliberately after a race, demanding block, illness, or excessive response. Progress again only after energy, mechanics, symptoms, and motivation normalize.

Progress phases by evidence of absorption rather than elapsed weeks: stable/improving output at comparable HR/power, acceptable drift, no persistent within-week deterioration, normal long-run recovery, stable mechanics, manageable symptoms, and strides without residual soreness.

## Session controls

- Recovery/easy: breathing, RPE, and HR ceiling primary; power secondary; pace is an outcome.
- Aerobic/long: aerobic effort and HR/power stability primary; evaluate drift and late-run preservation.
- Steady: power or grade-adjusted pace primary; HR and RPE guard against threshold creep.
- Threshold: interval pace or power primary; late-interval HR and RPE secondary; seek repeatable controlled work.
- VO2/5K/anaerobic: pace, power, consistency, and mechanics primary; do not chase short-repetition HR.
- Hills: time, form, power, and RPE primary; never compare uphill pace directly with flat pace.

## Weekly policy

Prescribe duration first and approximate distance second. Include the phase, objective, total duration, distance range, quality count, long-run duration, strength, day-by-day purpose and controls, a fallback for every key session, modification triggers, what is deliberately absent, and the next decision point.

Use a two-weeks-up/one-week-down rhythm only as a prior. Require repeated evidence before progressing volume. Keep key running days and lower-body strength far enough apart to restore normal mechanics.

## Future-block policy

Plan one to three weeks as a coherent block, not as unrelated weekly suggestions. The first week is based on currently observed evidence. Weeks two and three are contingent continuations: they may express the intended phase progression, but they must not treat an uncompleted earlier week as absorbed training.

- Keep every future session dated, versioned, and linked to the decision that created it.
- State the continuation conditions for each later week.
- Re-evaluate after consequential sessions and at least once per week.
- Adapt only affected future sessions; preserve the accepted original and the reason for every patch.
- Never move a missed session forward merely to complete the block.
- An accepted future block is a plan under current evidence, not a promise to execute it unchanged.

## Post-run verdict and adaptation

Evaluate external dose, internal cost, mechanical cost, and recovery implication. Return exactly one verdict: Absorbed, Productive but costly, Excessive for current state, Inconclusive, or Pain/injury concern.

- Costly easy run: shorten/gentle the next easy run and reassess upcoming quality while preserving safe frequency.
- Costly quality run: retain the benefit, add recovery, add no bonus work, and downgrade the next quality session if normality does not return.
- Exceptionally good run: record positive evidence; do not immediately increase both volume and intensity or change zones.
- Accumulating fatigue: remove intensity first, shorten runs second, reduce frequency last.
- Pain that worsens or changes gait: make performance secondary, reduce the plan, and recommend appropriate professional assessment.

Propose patches only to future sessions. Preserve the original plan, evidence, reason, previous/new plan versions, and acceptance status. Apply nothing silently.
