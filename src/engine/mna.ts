/**
 * Modified Nodal Analysis (MNA) matrix builder and solver.
 *
 * The MNA system: [G] * [x] = [b]
 *   G: (N+M) x (N+M) conductance matrix
 *   x: [V1..VN, I_vs1..I_vsM] — node voltages and voltage source currents
 *   b: right-hand side (source contributions)
 *
 * N = number of non-ground nodes
 * M = number of independent voltage sources
 * Node 0 is ground (not included in the matrix).
 */

/**
 * Create an empty MNA system of the given size.
 */
export function createMNA(size: number): { G: number[][]; b: number[] } {
  const G: number[][] = [];
  for (let i = 0; i < size; i++) {
    G.push(new Array(size).fill(0));
  }
  return { G, b: new Array(size).fill(0) };
}

/**
 * Stamp a conductance (resistor) between nodes a and b.
 * g = 1/R. Nodes are 1-indexed; node 0 = ground (skipped).
 */
export function stampConductance(G: number[][], a: number, b: number, g: number): void {
  if (a > 0) G[a - 1][a - 1] += g;
  if (b > 0) G[b - 1][b - 1] += g;
  if (a > 0 && b > 0) {
    G[a - 1][b - 1] -= g;
    G[b - 1][a - 1] -= g;
  }
}

/**
 * Stamp a current source from node a to node b (current flows a -> b).
 * Positive value = current entering node b, leaving node a.
 */
export function stampCurrentSource(b_vec: number[], a: number, b: number, current: number): void {
  if (a > 0) b_vec[a - 1] -= current;
  if (b > 0) b_vec[b - 1] += current;
}

/**
 * Stamp a voltage source: V(a) - V(b) = voltage.
 * branchIdx is the row/col index for the extra MNA variable (0-indexed into the M section).
 * N = number of non-ground nodes.
 */
export function stampVoltageSource(
  G: number[][], b_vec: number[],
  a: number, b: number,
  voltage: number,
  N: number, branchIdx: number
): void {
  const row = N + branchIdx;
  if (a > 0) {
    G[row][a - 1] = 1;
    G[a - 1][row] = 1;
  }
  if (b > 0) {
    G[row][b - 1] = -1;
    G[b - 1][row] = -1;
  }
  b_vec[row] = voltage;
}

/**
 * Solve [G][x] = [b] using Gaussian elimination with partial pivoting.
 * Returns the solution vector x, or null if the system is singular.
 */
export function solve(G: number[][], b: number[]): number[] | null {
  const n = b.length;

  // Build augmented matrix [G | b]
  const aug: number[][] = [];
  for (let i = 0; i < n; i++) {
    aug.push([...G[i], b[i]]);
  }

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxVal = Math.abs(aug[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      const val = Math.abs(aug[row][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = row;
      }
    }

    if (maxVal < 1e-15) {
      // Singular matrix — add tiny conductance to ground for stability
      aug[col][col] += 1e-9;
    }

    // Swap rows
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Eliminate below
    const pivot = aug[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / pivot;
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n]; // RHS
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    const diag = aug[i][i];
    if (Math.abs(diag) < 1e-15) {
      x[i] = 0; // Floating node defaults to 0V
    } else {
      x[i] = sum / diag;
    }
  }

  return x;
}

/**
 * Solve the dense n×n system A·x = b in place (Gaussian elimination with
 * partial pivoting). `A` is row-major (A[i*n + j]); on return `b` holds x
 * and `A` is destroyed. A pivot below 1e-30 means the row is floating: that
 * unknown is set to 0 instead of producing Infinity/NaN.
 */
export function solveDenseInPlace(A: Float64Array, b: Float64Array, n: number): void {
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    let maxVal = Math.abs(A[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row * n + col]);
      if (v > maxVal) { maxVal = v; maxRow = row; }
    }
    if (maxVal < 1e-30) continue; // singular column: leave for back-substitution
    if (maxRow !== col) {
      const r1 = col * n, r2 = maxRow * n;
      for (let j = col; j < n; j++) {
        const t = A[r1 + j]; A[r1 + j] = A[r2 + j]; A[r2 + j] = t;
      }
      const t = b[col]; b[col] = b[maxRow]; b[maxRow] = t;
    }
    const pr = col * n;
    const inv = 1 / A[pr + col];
    for (let row = col + 1; row < n; row++) {
      const rr = row * n;
      const f = A[rr + col] * inv;
      if (f === 0) continue;
      A[rr + col] = 0;
      for (let j = col + 1; j < n; j++) A[rr + j] -= f * A[pr + j];
      b[row] -= f * b[col];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    const ri = i * n;
    let sum = b[i];
    for (let j = i + 1; j < n; j++) sum -= A[ri + j] * b[j];
    const d = A[ri + i];
    b[i] = Math.abs(d) < 1e-30 ? 0 : sum / d;
  }
}
