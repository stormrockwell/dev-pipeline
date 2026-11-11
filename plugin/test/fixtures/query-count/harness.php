<?php
/**
 * Query count trait harness
 *
 * Runs the trait against a stub $wpdb, one scenario per argument, and prints the outcome as JSON.
 */

require __DIR__ . '/../../../../templates/testing/php/AssertsQueryCount.php';

class Stub_Wpdb {
	public $num_queries = 0;

	public function query( $sql ) {
		global $filters;
		foreach ( $filters as $filter ) {
			$sql = $filter( $sql );
		}
		++$this->num_queries;
	}
}

$filters = array();
function add_filter( $name, $callback ) {
	global $filters;
	$filters[ spl_object_id( $callback ) ] = $callback;
}
function remove_filter( $name, $callback ) {
	global $filters;
	unset( $filters[ spl_object_id( $callback ) ] );
}

class Stub_Failure extends Exception {}

class Stub_Case {
	use Pipeline\Testing\AssertsQueryCount;

	public function assertLessThanOrEqual( $expected, $actual, $message = '' ) {
		if ( $actual > $expected ) {
			throw new Stub_Failure( $message );
		}
	}

	public function run( $scenario ) {
		global $wpdb;
		$arrange = static fn( $items ) => range( 1, $items );
		switch ( $scenario ) {
			case 'constant':
				$render = static function ( $items ) use ( $wpdb ) {
					$wpdb->query( 'SELECT ... WHERE ID IN (...)' );
					$wpdb->query( 'SELECT ... meta WHERE post_id IN (...)' );
				};
				return $this->assert_query_count_does_not_grow( $arrange, $render );
			case 'n-plus-one':
				$render = static function ( $items ) use ( $wpdb ) {
					$wpdb->query( 'SELECT ... posts' );
					foreach ( $items as $item ) {
						$wpdb->query( 'SELECT meta_value WHERE post_id = ' . $item );
					}
				};
				return $this->assert_query_count_does_not_grow( $arrange, $render );
			case 'allowance':
				$render = static function ( $items ) use ( $wpdb ) {
					$wpdb->query( 'SELECT ... posts' );
					if ( count( $items ) > 50 ) {
						$wpdb->query( 'SELECT FOUND_ROWS()' );
					}
				};
				return $this->assert_query_count_does_not_grow( $arrange, $render, 10, 100, 1 );
			case 'filter':
				$render = static function ( $items ) use ( $wpdb ) {
					foreach ( $items as $item ) {
						$wpdb->query( 'SELECT ' . $item );
					}
				};
				return $this->assert_query_count_does_not_grow( $arrange, $render, 10, 100, 0, 'filter' );
			case 'arrange-uncounted':
				$arrange = static function ( $items ) use ( $wpdb ) {
					foreach ( range( 1, $items ) as $item ) {
						$wpdb->query( 'INSERT item ' . $item );
					}
					return $items;
				};
				$render  = static function () use ( $wpdb ) {
					$wpdb->query( 'SELECT ... posts' );
				};
				return $this->assert_query_count_does_not_grow( $arrange, $render );
		}
		throw new InvalidArgumentException( "unknown scenario $scenario" );
	}
}

$results = array();
foreach ( array_slice( $argv, 1 ) as $scenario ) {
	$wpdb = new Stub_Wpdb();
	try {
		( new Stub_Case() )->run( $scenario );
		$results[ $scenario ] = array( 'failed' => false );
	} catch ( Stub_Failure $failure ) {
		$results[ $scenario ] = array(
			'failed'  => true,
			'message' => $failure->getMessage(),
		);
	}
}
echo json_encode( $results );
