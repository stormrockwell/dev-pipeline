<?php
/**
 * N+1 query detection for WordPress PHPUnit suites
 *
 * Mix the trait into a test case that extends WP_UnitTestCase. It renders the same code with a
 * small and a large number of items and fails when the query count grows with the item count,
 * which is what a query inside a loop does.
 *
 * @package Pipeline\Testing
 */

namespace Pipeline\Testing;

trait AssertsQueryCount {

	/**
	 * Counts the queries a callback runs
	 *
	 * The default source reads the growth of $wpdb->num_queries. The `filter` source counts calls of
	 * the `query` filter instead, for a suite that swaps $wpdb or resets its counter.
	 *
	 * @param callable $callback Code to measure.
	 * @param string   $source   Either `num_queries` or `filter`.
	 * @return int
	 */
	protected function count_queries( callable $callback, string $source = 'num_queries' ): int {
		global $wpdb;

		if ( 'filter' === $source ) {
			$count   = 0;
			$counter = static function ( $query ) use ( &$count ) {
				++$count;
				return $query;
			};
			\add_filter( 'query', $counter );
			try {
				$callback();
			} finally {
				\remove_filter( 'query', $counter );
			}
			return $count;
		}

		$before = $wpdb->num_queries;
		$callback();
		return $wpdb->num_queries - $before;
	}

	/**
	 * Measures the queries one render runs at each of two item counts
	 *
	 * The arrange callback builds the items and is never counted. The object cache is flushed after
	 * it, so both renders start cold and a cache that fills during the render cannot hide a loop.
	 *
	 * @param callable $arrange Receives an item count and returns what the render needs.
	 * @param callable $render  Receives what arrange returned, and renders it.
	 * @param int      $small   The small item count.
	 * @param int      $large   The large item count.
	 * @param string   $source  The counting source of count_queries().
	 * @return array<int, int> Query count keyed by item count.
	 */
	protected function measure_render_queries( callable $arrange, callable $render, int $small, int $large, string $source ): array {
		$counts = array();
		foreach ( array( $small, $large ) as $items ) {
			$arranged = $arrange( $items );
			if ( function_exists( 'wp_cache_flush' ) ) {
				\wp_cache_flush();
			}
			$counts[ $items ] = $this->count_queries(
				static function () use ( $render, $arranged ) {
					$render( $arranged );
				},
				$source
			);
		}
		return $counts;
	}

	/**
	 * Fails when a render's query count grows with the number of items
	 *
	 * A fixed number of extra queries for the larger render is allowed through $allowance, for work
	 * such as a pagination count. Anything that scales with the items is not.
	 *
	 * @param callable $arrange   Receives an item count and returns what the render needs.
	 * @param callable $render    Receives what arrange returned, and renders it.
	 * @param int      $small     The small item count, 10 by default.
	 * @param int      $large     The large item count, 100 by default.
	 * @param int      $allowance Extra queries the large render may run.
	 * @param string   $source    Either `num_queries` or `filter`.
	 * @return void
	 */
	protected function assert_query_count_does_not_grow( callable $arrange, callable $render, int $small = 10, int $large = 100, int $allowance = 0, string $source = 'num_queries' ): void {
		$counts = $this->measure_render_queries( $arrange, $render, $small, $large, $source );
		$extra  = $counts[ $large ] - $counts[ $small ];

		$this->assertLessThanOrEqual(
			$allowance,
			$extra,
			sprintf(
				'Rendering %1$d items ran %2$d queries and %3$d items ran %4$d, so the count grows with the items by about %5$.1f per item. Look for a query inside a loop, such as get_post_meta() or get_term() per item, and read them in one query or prime the cache first.',
				$large,
				$counts[ $large ],
				$small,
				$counts[ $small ],
				$extra / max( 1, $large - $small )
			)
		);
	}
}
