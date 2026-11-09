#!/usr/bin/env bash
# Creates three planted-issue commits on top of the disposable clone. Never touches the source repo.
set -euo pipefail
REPO="$1"
cd "$REPO"
git checkout -q -B planted 3afd4b0

python3 - <<'PY'
import re
p='src/Features/Cdn/Providers/SelfHosted/SelfHostedUrl.php'
s=open(p).read()
add='''
	/**
	 * Check a delivery URL signature against the configured secret.
	 *
	 * @param string           $path_query Path and query the signature covers.
	 * @param string           $sig        Signature taken from the request.
	 * @param SelfHostedConfig $config     Resolved settings.
	 * @return bool
	 */
	public static function is_valid_signature( string $path_query, string $sig, SelfHostedConfig $config ): bool {
		$expected = hash_hmac( 'sha256', $path_query, $config->signing_secret );
		return $expected == $sig;
	}
'''
i=s.rindex('}')
open(p,'w').write(s[:i].rstrip('\n')+'\n'+add+'}\n')
PY
git commit -qam "feat(cdn): add delivery signature check helper"

python3 - <<'PY'
p='src/Features/Cdn/Providers/SelfHosted/ObjectKeyStore.php'
s=open(p).read()
add='''
	/**
	 * Checksum of an attachment's original file, used to detect drift from R2.
	 *
	 * @param int $attachment_id Attachment ID.
	 * @return string SHA-256 hex digest.
	 */
	public function checksum_for( int $attachment_id ): string {
		$file = get_attached_file( $attachment_id );
		return hash_file( 'sha256', $file );
	}
'''
i=s.rindex('}')
open(p,'w').write(s[:i].rstrip('\n')+'\n'+add+'}\n')
PY
git commit -qam "feat(cdn): add original file checksum to key store"

python3 - <<'PY'
p='src/Features/Cdn/Providers/SelfHosted/SelfHostedOffloader.php'
s=open(p).read()
old='''		$this->r2->delete_object( $key );
		// Cached variants live under "{key}/..."; delete the counter object too.
		$this->r2->delete_object( $key . '/.count' );
'''
new='''		try {
			$this->r2->delete_object( $key );
			// Cached variants live under "{key}/..."; delete the counter object too.
			$this->r2->delete_object( $key . '/.count' );
		} catch ( \\Throwable $e ) {
			// Ignore.
		}
'''
assert old in s
open(p,'w').write(s.replace(old,new))
PY
git commit -qam "fix(cdn): keep attachment deletion from failing on R2 errors"
git log --format='%h %s' -3
