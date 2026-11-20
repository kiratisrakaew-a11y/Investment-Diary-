/** Linear programming (moved from risk-strategies so the optimizer can use it without a circular import). */
// ------------------------------------------------------------------ linear programming

export interface LpRow {
  a: number[];
  op: "<=" | ">=" | "=";
  b: number;
}

export interface LpResult {
  status: "optimal" | "infeasible" | "unbounded" | "iteration_limit";
  x: number[];
  objective: number;
  iterations: number;
}

/**
 * min cᵀx s.t. rows, x ≥ 0. Dense two-phase tableau simplex: Dantzig pricing, switching to Bland's
 * rule after repeated degenerate pivots (no cycling). Unit columns already present are used as the
 * starting basis, so artificials are added only where needed.
 */
export function solveLP(c: number[], rows: LpRow[], maxIter = 20000): LpResult {
  const n = c.length;
  const m = rows.length;
  const tol = 1e-9;
  // Normalize to b ≥ 0.
  const R = rows.map(
    (r) =>
      (r.b < 0
        ? {
            a: r.a.map((v) => -v),
            op: r.op === "<=" ? ">=" : r.op === ">=" ? "<=" : "=",
            b: -r.b,
          }
        : { ...r, a: [...r.a] }) as LpRow,
  );
  // Columns: original | slack/surplus | artificial.
  const slackOf: number[] = Array(m).fill(-1);
  let cols = n;
  for (let i = 0; i < m; i++) if (R[i].op !== "=") slackOf[i] = cols++;
  // A unit column among originals (coefficient 1 here, 0 in every other row) can start in the basis.
  const isUnitIn = (j: number): number => {
    let row = -1;
    for (let i = 0; i < m; i++) {
      const v = R[i].a[j];
      if (Math.abs(v) > tol) {
        if (row >= 0 || Math.abs(v - 1) > tol) return -1;
        row = i;
      }
    }
    return row;
  };
  const basis: number[] = Array(m).fill(-1);
  const unitRow = new Map<number, number>();
  for (let j = 0; j < n; j++) {
    const r = isUnitIn(j);
    if (r >= 0 && !unitRow.has(r)) unitRow.set(r, j);
  }
  for (let i = 0; i < m; i++) {
    if (R[i].op === "<=") basis[i] = slackOf[i];
    else if (unitRow.has(i)) basis[i] = unitRow.get(i)!;
  }
  const artOf: number[] = Array(m).fill(-1);
  for (let i = 0; i < m; i++) if (basis[i] < 0) basis[i] = artOf[i] = cols++;
  const W = cols + 1;
  const T: Float64Array[] = Array.from(
    { length: m },
    () => new Float64Array(W),
  );
  for (let i = 0; i < m; i++) {
    const row = T[i];
    for (let j = 0; j < n; j++) row[j] = R[i].a[j];
    if (slackOf[i] >= 0) row[slackOf[i]] = R[i].op === "<=" ? 1 : -1;
    if (artOf[i] >= 0) row[artOf[i]] = 1;
    row[cols] = R[i].b;
  }
  const isArt = new Uint8Array(cols);
  for (const a of artOf) if (a >= 0) isArt[a] = 1;
  let iterations = 0;

  const run = (
    cost: Float64Array,
    allowArt: boolean,
  ): "optimal" | "unbounded" | "iteration_limit" => {
    // Reduced costs d_j = c_j − Σ c_B(i) T[i][j]; objective value in d[cols] (negated).
    const d = new Float64Array(W);
    for (let j = 0; j < W; j++) d[j] = j < cols ? cost[j] : 0;
    for (let i = 0; i < m; i++) {
      const cb = cost[basis[i]];
      if (cb !== 0) for (let j = 0; j < W; j++) d[j] -= cb * T[i][j];
    }
    let degenerate = 0;
    while (iterations < maxIter) {
      const bland = degenerate > 50;
      let e = -1;
      let best = -tol;
      for (let j = 0; j < cols; j++) {
        if (!allowArt && isArt[j]) continue;
        if (d[j] < best) {
          e = j;
          if (bland) break;
          best = d[j];
        }
      }
      if (e < 0) return "optimal";
      let leave = -1;
      let ratio = Infinity;
      for (let i = 0; i < m; i++) {
        const v = T[i][e];
        if (v > tol) {
          const r = T[i][cols] / v;
          if (
            r < ratio - 1e-12 ||
            (Math.abs(r - ratio) <= 1e-12 &&
              leave >= 0 &&
              basis[i] < basis[leave])
          ) {
            ratio = r;
            leave = i;
          }
        }
      }
      if (leave < 0) return "unbounded";
      degenerate = ratio <= tol ? degenerate + 1 : 0;
      // Pivot.
      const pr = T[leave];
      const pv = pr[e];
      for (let j = 0; j < W; j++) pr[j] /= pv;
      for (let i = 0; i < m; i++) {
        if (i === leave) continue;
        const f = T[i][e];
        if (f !== 0) {
          const row = T[i];
          for (let j = 0; j < W; j++) row[j] -= f * pr[j];
        }
      }
      const fd = d[e];
      if (fd !== 0) for (let j = 0; j < W; j++) d[j] -= fd * pr[j];
      basis[leave] = e;
      iterations++;
    }
    return "iteration_limit";
  };

  const extract = () => {
    const x = Array(n).fill(0);
    for (let i = 0; i < m; i++) if (basis[i] < n) x[basis[i]] = T[i][cols];
    return x;
  };
  if (artOf.some((a) => a >= 0)) {
    const c1 = new Float64Array(cols);
    for (let j = 0; j < cols; j++) c1[j] = isArt[j] ? 1 : 0;
    const s1 = run(c1, true);
    if (s1 === "iteration_limit")
      return {
        status: "iteration_limit",
        x: extract(),
        objective: NaN,
        iterations,
      };
    const infeas = basis.reduce(
      (s, b, i) => s + (isArt[b] ? T[i][cols] : 0),
      0,
    );
    if (infeas > 1e-7 * Math.max(1, ...R.map((r) => Math.abs(r.b))))
      return { status: "infeasible", x: extract(), objective: NaN, iterations };
    // Drive zero-level artificials out of the basis where possible.
    for (let i = 0; i < m; i++) {
      if (!isArt[basis[i]]) continue;
      const j = T[i].findIndex(
        (v, k) => k < cols && !isArt[k] && Math.abs(v) > 1e-9,
      );
      if (j < 0) continue; // redundant row; the artificial stays basic at zero and never re-enters
      const pr = T[i];
      const pv = pr[j];
      for (let k = 0; k < W; k++) pr[k] /= pv;
      for (let r = 0; r < m; r++) {
        if (r === i) continue;
        const f = T[r][j];
        if (f !== 0) for (let k = 0; k < W; k++) T[r][k] -= f * pr[k];
      }
      basis[i] = j;
    }
  }
  const c2 = new Float64Array(cols);
  for (let j = 0; j < n; j++) c2[j] = c[j];
  const s2 = run(c2, false);
  const x = extract();
  return {
    status: s2,
    x,
    objective: c.reduce((s, cj, j) => s + cj * x[j], 0),
    iterations,
  };
}
