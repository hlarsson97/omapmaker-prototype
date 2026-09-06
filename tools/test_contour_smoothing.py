import unittest
import numpy as np
from generate_contours import smooth_line


def reference_smoothing(points, iterations):
    """Previous scalar algorithm: numerical compatibility oracle."""
    result = np.asarray(points)
    if iterations <= 0 or len(result) < 4:
        return result
    closed = np.linalg.norm(result[0] - result[-1]) < 1e-6
    for _ in range(iterations):
        source = result[:-1] if closed else result
        smoothed = [] if closed else [source[0]]
        for index in range(len(source) if closed else len(source) - 1):
            first, second = source[index], source[(index + 1) % len(source)]
            smoothed.append(0.75 * first + 0.25 * second)
            smoothed.append(0.25 * first + 0.75 * second)
        smoothed.append(smoothed[0] if closed else source[-1])
        result = np.asarray(smoothed)
    return result


class ContourSmoothingTests(unittest.TestCase):
    def test_matches_previous_algorithm_exactly(self):
        random = np.random.default_rng(42)
        for dtype in [np.float32, np.float64, np.int64]:
            for count in [0, 1, 2, 3, 4, 17, 1000]:
                for closed in [False, True]:
                    points = (random.normal(size=(count, 2)) * 100).astype(dtype)
                    if closed and count:
                        points[-1] = points[0]
                    for iterations in [0, 1, 2, 4]:
                        with self.subTest(dtype=dtype, count=count, closed=closed, iterations=iterations):
                            original = points.copy()
                            expected = reference_smoothing(points, iterations)
                            actual = smooth_line(points, iterations)
                            np.testing.assert_array_equal(actual, expected)
                            self.assertEqual(actual.dtype, expected.dtype)
                            np.testing.assert_array_equal(points, original)

    def test_endpoints_closure_and_repeated_points(self):
        for points in [np.zeros((8, 2)), np.array([[0., 0.], [0., 0.], [1., 2.], [2., 3.]]),
                       np.array([[0., 0.], [1., 2.], [2., 3.], [0., 0.0000001]])]:
            np.testing.assert_array_equal(smooth_line(points, 3), reference_smoothing(points, 3))


if __name__ == '__main__':
    unittest.main()
