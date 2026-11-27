import gliders


def test_simplify_keeps_vertices_within_the_max_step():
    # A straight line sampled hourly for three days: RDP alone keeps two ends.
    pts = [(i * 0.01, 49.0, i * 3600) for i in range(72)]
    assert len(gliders._simplify(pts, 0.002)) == 2
    kept = gliders._simplify(pts, 0.002, 12 * 3600)
    steps = [b[2] - a[2] for a, b in zip(kept, kept[1:])]
    assert kept[0] == pts[0] and kept[-1] == pts[-1]
    assert max(steps) <= 12 * 3600


def test_simplify_leaves_a_real_data_gap_as_one_step():
    pts = [(0.0, 49.0, 0), (0.01, 49.0, 3600), (0.02, 49.0, 30 * 86400), (0.03, 49.0, 30 * 86400 + 3600)]
    kept = gliders._simplify(pts, 0.002, 12 * 3600)
    assert any(b[2] - a[2] > 12 * 3600 for a, b in zip(kept, kept[1:]))
    assert kept[0] == pts[0] and kept[-1] == pts[-1]


def test_argo_sections_fill_gaps_inside_a_profile_only():
    import numpy as np
    from gliders import _fill_vertical_gaps
    grid = np.array([[np.nan], [1.0], [np.nan], [np.nan], [4.0], [np.nan]])
    _fill_vertical_gaps(grid)
    assert np.isnan(grid[0, 0]) and np.isnan(grid[5, 0])
    assert grid[2, 0] == 2.0 and grid[3, 0] == 3.0
