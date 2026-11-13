import { describe, expect, it } from "vitest";
import { builtinConfig, parseConfig } from "../../src/commands/scan-zones/config.ts";
import { scanFile, scanText } from "../../src/commands/scan-zones/scan.ts";
import type { Zone } from "../../src/commands/scan-zones/types.ts";

const config = builtinConfig();

function linesIn(zone: Zone, content: string): number[] {
  return scanText(config, "src/Thing.php", content)
    .matches.filter((match) => match.zone === zone)
    .map((match) => match.line ?? 0);
}

const abilityClass = `<?php
class Rename_Ability extends Base_Ability {
	protected function execute( $params ): array {
		return $this->apply( $params );
	}

	protected function apply( array $params ): array {
		update_option( 'blogname', $params['name'] );
		update_option( 'blogdescription', 'fixed text' );
		return array();
	}

	protected function fetch( string $url ) {
		return wp_safe_remote_get( $url );
	}

	protected function store( string $url ) {
		$tmp = download_url( $url );
		return media_handle_sideload( array( 'tmp_name' => $tmp ), 0 );
	}
}
`;

const registered = `<?php
wp_register_ability( 'demo/save', array(
	'execute_callback' => function ( $input ) {
		return wp_update_post( $input );
	},
) );
`;

const unrelated = `<?php
class Report {
	public function build( array $params ): array {
		update_option( 'last_report', $params['id'] );
		wp_remote_get( $params['url'] );
		return array();
	}
}
`;

describe("ability caller input", () => {
  it("flags writes, outbound requests and uploads in a file that defines an execute method", () => {
    expect(linesIn("input", abilityClass)).toEqual([8, 14, 18, 19]);
  });

  it("leaves a write of literals alone", () => {
    expect(linesIn("input", abilityClass)).not.toContain(9);
  });

  it("flags a write inside an execute_callback closure", () => {
    expect(linesIn("input", registered)).toEqual([4]);
  });

  it("does not flag the same calls with an unrelated $params outside an ability", () => {
    expect(linesIn("input", unrelated)).toEqual([]);
  });

  it("skips a removed line, which has no file to hold the ability", () => {
    const scan = scanFile(config, {
      path: "src/Thing.php",
      content: abilityClass,
      added: new Set(),
      removed: [{ line: 8, text: "update_option( 'blogname', $params['name'] );" }],
      deleted: false,
    });
    expect(scan.removed).toEqual([]);
  });

  it("accepts a file pattern in sensitive.yml", () => {
    const custom = parseConfig(
      "signals:\n  php:\n    - pattern: 'save\\('\n      zone: input\n      file: 'class Tool'\n",
    );
    expect(scanText(custom, "a.php", "class Tool {}\nsave($x);\n").matches).toHaveLength(1);
    expect(scanText(custom, "a.php", "class Other {}\nsave($x);\n").matches).toHaveLength(0);
  });
});

describe("login and menu signals", () => {
  it.each([
    ["if ( ! is_user_logged_in() ) {", "auth"],
    ["wp_delete_nav_menu( $menu_id );", "data-loss"],
  ] as [string, Zone][])("flags %s", (line, zone) => {
    expect(scanText(config, "a.php", `${line}\n`).zones).toContain(zone);
  });
});
