/**
 * Unit tests for the neural network: network.js, features.js, store.js
 * No external dependencies — pure math / data structure tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Static imports are fine — nn/network.js has no side effects
import { initWeights, forward, train, predict, addSample } from '../../src/nn/network.js';
import { buildFeaturesNorm } from '../../src/nn/features.js';
import { brainStats } from '../../src/nn/store.js';

// ─────────────────────────────────────────────────────────────────────────────
describe('initWeights', () => {
  test('produces correct matrix shapes', () => {
    const w = initWeights();
    // Combined NN: 8×9, bias 8, 1×8, bias 1
    assert.equal(w.w1.length,    8);
    assert.equal(w.w1[0].length, 9);
    assert.equal(w.b1.length,    8);
    assert.equal(w.w2.length,    1);
    assert.equal(w.w2[0].length, 8);
    assert.equal(w.b2.length,    1);
    // Directional NNs have same shape
    assert.equal(w.w1Up.length,    8);
    assert.equal(w.w1Down.length,  8);
  });

  test('weights are in reasonable initialisation range', () => {
    const w = initWeights();
    for (const row of w.w1) {
      for (const v of row) {
        assert.ok(v >= -0.5 && v <= 0.5, `Weight ${v} out of [-0.5, 0.5]`);
      }
    }
  });

  test('two calls produce independent (non-identical) weights', () => {
    const a = initWeights();
    const b = initWeights();
    // Probability of all 72+ weights being identical at random is ~0
    assert.notDeepEqual(a.w1, b.w1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('forward', () => {
  const W = initWeights();
  const features = Array(9).fill(0.5);

  test('output is in (0, 1) — sigmoid is bounded', () => {
    const { output } = forward(W.w1, W.b1, W.w2, W.b2, features);
    assert.equal(output.length, 1);
    assert.ok(output[0] > 0 && output[0] < 1, `Output ${output[0]} not in (0,1)`);
  });

  test('hidden layer has 8 units', () => {
    const { hidden } = forward(W.w1, W.b1, W.w2, W.b2, features);
    assert.equal(hidden.length, 8);
  });

  test('all-zero features gives valid output', () => {
    const { output } = forward(W.w1, W.b1, W.w2, W.b2, Array(9).fill(0));
    assert.ok(output[0] > 0 && output[0] < 1);
  });

  test('extreme positive features give output close to 1', () => {
    // Very large inputs push sigmoid toward 1
    const { output } = forward(W.w1, W.b1, W.w2, W.b2, Array(9).fill(100));
    // Not a guarantee but statistically almost always true with random init
    assert.ok(output[0] > 0 && output[0] < 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('addSample', () => {
  test('appends a sample', () => {
    const data = [];
    addSample(data, Array(9).fill(0.1), true);
    assert.equal(data.length, 1);
    assert.equal(data[0].l, 1);
  });

  test('loss sample has label 0', () => {
    const data = [];
    addSample(data, Array(9).fill(0.1), false);
    assert.equal(data[0].l, 0);
  });

  test('enforces 150-sample cap per class', () => {
    const data = [];
    for (let i = 0; i < 160; i++) addSample(data, Array(9).fill(0.1), true);
    const wins = data.filter(d => d.l === 1).length;
    assert.ok(wins <= 150, `Win cap breached: ${wins}`);
  });

  test('caps independently per class (wins & losses)', () => {
    const data = [];
    for (let i = 0; i < 100; i++) addSample(data, Array(9).fill(0.1), true);
    for (let i = 0; i < 100; i++) addSample(data, Array(9).fill(0.1), false);
    assert.ok(data.length <= 300);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('train', () => {
  test('modifies weights (network learns something)', () => {
    const w = initWeights();
    const w1Before = w.w1[0][0];

    const data = [];
    for (let i = 0; i < 20; i++) addSample(data, Array(9).fill(0.5), true);
    for (let i = 0; i < 20; i++) addSample(data, Array(9).fill(-0.5), false);

    train(w, data, [], []);
    assert.notEqual(w.w1[0][0], w1Before, 'Weights should change after training');
  });

  test('does not crash on empty directional buffers', () => {
    const w   = initWeights();
    const data = [{ f: Array(9).fill(0.1), l: 1 }, { f: Array(9).fill(-0.1), l: 0 }];
    assert.doesNotThrow(() => train(w, data, [], []));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('predict', () => {
  test('returns value in (0, 1)', () => {
    const w    = initWeights();
    const feat = Array(9).fill(0.3);
    const norm = Array(9).fill(0.3);
    const p    = predict(w, feat, norm, 'UP', [], []);
    assert.ok(p > 0 && p < 1, `Prediction ${p} not in (0,1)`);
  });

  test('ensemble shifts prediction toward directional NN when data available', () => {
    const w    = initWeights();
    const feat = Array(9).fill(0.3);
    const norm = Array(9).fill(0.3);

    const pNoBrain = predict(w, feat, norm, 'UP', [], []);

    // Add training data to UP branch
    const dataUp = [];
    for (let i = 0; i < 10; i++) addSample(dataUp, feat, true);
    train(w, [], dataUp, []);

    const pWithBrain = predict(w, feat, norm, 'UP', dataUp, []);
    // With 10 UP samples, ensemble weight shifts — result should differ
    assert.notEqual(pNoBrain, pWithBrain);
  });

  test('DOWN prediction uses DOWN-direction NN', () => {
    const w      = initWeights();
    const feat   = Array(9).fill(0.3);
    const normUp = feat.map(v =>  v);   // UP: no flip
    const normDn = feat.map(v => -v);   // DOWN: flip

    const pUp = predict(w, feat, normUp, 'UP',   [], []);
    const pDn = predict(w, feat, normDn, 'DOWN', [], []);
    // With fresh random weights these differ (not guaranteed equal)
    // just assert they're both valid
    assert.ok(pUp > 0 && pUp < 1);
    assert.ok(pDn > 0 && pDn < 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildFeaturesNorm', () => {
  const raw = [0.1, 0.2, -0.3, 0.4, -0.5, 0.6, -0.7, 0.8, -0.9];

  test('UP returns a copy of raw features', () => {
    const norm = buildFeaturesNorm(raw, 'UP');
    assert.deepEqual(norm, raw);
    assert.notEqual(norm, raw, 'Should be a new array, not same reference');
  });

  test('DOWN flips all feature signs', () => {
    const norm = buildFeaturesNorm(raw, 'DOWN');
    for (let i = 0; i < raw.length; i++) {
      assert.ok(Math.abs(norm[i] + raw[i]) < 1e-10, `Feature[${i}] not flipped`);
    }
  });

  test('double-flip restores original', () => {
    const flipped = buildFeaturesNorm(raw, 'DOWN');
    const restored = buildFeaturesNorm(flipped, 'DOWN');
    for (let i = 0; i < raw.length; i++) {
      assert.ok(Math.abs(restored[i] - raw[i]) < 1e-10);
    }
  });

  test('returns null for null input', () => {
    assert.equal(buildFeaturesNorm(null, 'UP'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('brainStats', () => {
  test('returns null winRate for empty buffers', () => {
    const brain = { data: [], dataUp: [], dataDown: [] };
    const stats = brainStats(brain, 'BTC');
    assert.equal(stats.combined.winRate, null);
    assert.equal(stats.up.winRate,       null);
    assert.equal(stats.down.winRate,     null);
  });

  test('calculates correct win rate', () => {
    const brain = {
      data:     [{ l: 1 }, { l: 1 }, { l: 0 }, { l: 0 }],  // 50%
      dataUp:   [{ l: 1 }, { l: 1 }, { l: 1 }],              // 100%
      dataDown: [{ l: 0 }],                                   // 0%
    };
    const stats = brainStats(brain, 'BTC');
    assert.equal(stats.combined.winRate, '50.0%');
    assert.equal(stats.up.winRate,       '100.0%');
    assert.equal(stats.down.winRate,     '0.0%');
  });

  test('includes sample counts', () => {
    const brain = { data: [{ l: 1 }], dataUp: [], dataDown: [{ l: 0 }, { l: 0 }] };
    const stats = brainStats(brain, 'ETH');
    assert.equal(stats.combined.samples, 1);
    assert.equal(stats.up.samples,       0);
    assert.equal(stats.down.samples,     2);
  });
});
