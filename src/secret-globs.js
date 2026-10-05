// Secret-looking files inside trees a seat can read (its clone, the owner's checkout, read-only paths): unreadable for
// every engine. Used by the Claude sandbox settings (runner.js) and the Codex permission profile (engines/codex.js).
export const SECRET_GLOBS = ['**/.env', '**/.env.*', '**/.envrc', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks',
  '**/id_rsa*', '**/id_ecdsa*', '**/id_ed25519*', '**/credentials.json', '**/credentials', '**/*credentials*.json', '**/service-account*.json',
  '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.pgpass*', '**/.git-credentials', '**/secrets.yml', '**/secrets.yaml', '**/secrets.json'];
