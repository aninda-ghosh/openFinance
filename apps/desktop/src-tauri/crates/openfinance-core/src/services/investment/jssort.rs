//! `Array.prototype.sort(comparefn)` as V8 runs it (Torque `ArrayTimSort`).
//!
//! For arrays shorter than 64 elements V8's TimSort is one run: it counts the
//! leading ascending or strictly descending run (reversing a descending one)
//! and then binary-insertion-sorts the rest. That is reproduced exactly here,
//! including how a comparator returning NaN behaves (neither `< 0` nor `>= 0`).
//! Longer arrays use the same insertion steps; with a consistent comparator
//! every stable sort gives the same order, so only NaN-producing comparisons
//! on 64+ elements could differ from V8. Unlike `slice::sort_by`, this never
//! panics on an inconsistent comparator.

/// Sorts `items` in place with a JS comparator (`< 0`: `a` first).
pub fn js_sort_by<T>(items: &mut [T], mut compare: impl FnMut(&T, &T) -> f64) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let run = count_and_make_run(items, &mut compare);
    binary_insertion_sort(items, run, &mut compare);
}

/// V8 `CountAndMakeRun(0, n)`.
fn count_and_make_run<T>(items: &mut [T], compare: &mut impl FnMut(&T, &T) -> f64) -> usize {
    let n = items.len();
    let low = 1;
    if low == n {
        return 1;
    }
    let mut run_length = 2;
    let order = compare(&items[low], &items[low - 1]);
    let descending = order < 0.0;
    let mut previous = low;
    for idx in low + 1..n {
        let order = compare(&items[idx], &items[previous]);
        if descending {
            if order >= 0.0 {
                break;
            }
        } else if order < 0.0 {
            break;
        }
        previous = idx;
        run_length += 1;
    }
    if descending {
        items[..run_length].reverse();
    }
    run_length
}

/// V8 `BinaryInsertionSort(0, start, n)`.
fn binary_insertion_sort<T>(
    items: &mut [T],
    start: usize,
    compare: &mut impl FnMut(&T, &T) -> f64,
) {
    let start = if start == 0 { 1 } else { start };
    for i in start..items.len() {
        let mut left = 0;
        let mut right = i;
        while left < right {
            let mid = left + ((right - left) >> 1);
            let order = compare(&items[i], &items[mid]);
            if order < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        items[left..=i].rotate_right(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_stably() {
        let mut v = vec![(3.0, 'a'), (1.0, 'b'), (3.0, 'c'), (2.0, 'd'), (1.0, 'e')];
        js_sort_by(&mut v, |a, b| b.0 - a.0);
        assert_eq!(
            v.iter().map(|x| x.1).collect::<String>(),
            "acdbe",
            "descending by key, ties in input order"
        );
        let mut v: Vec<f64> = (0..100).map(|i| f64::from((i * 37) % 101)).collect();
        js_sort_by(&mut v, |a, b| a - b);
        assert!(v.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn nan_comparisons_follow_v8() {
        // [1, NaN, 3, 2] sorted with (a, b) => a - b gives [1, NaN, 2, 3] in V8:
        // the first run is 1, NaN, 3 (NaN never breaks an ascending run), and
        // 2 is inserted by binary search against NaN (treated as "not less").
        let mut v = vec![1.0, f64::NAN, 3.0, 2.0];
        js_sort_by(&mut v, |a, b| a - b);
        assert_eq!(v[0], 1.0);
        assert!(v[1].is_nan());
        assert_eq!(&v[2..], &[2.0, 3.0]);
    }
}
