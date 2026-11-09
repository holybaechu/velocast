# Consumer setup

Use the project's installed CLI (`npx --no-install velocast`) and matching Velocast
packages. `velocast skills` lists the bundled skill; `velocast skills install`
copies it into `.agents/skills/velocast` in the current project. Reload the agent's
skills after installation. For an agent-specific skill root, pass
`--directory <skills-root>`; the command creates a `velocast` child there.

Create a project outside the framework checkout:

```sh
velocast init my-video --template blank
cd my-video
npm install
npx --no-install velocast doctor --json
npm run build
npx --no-install velocast compositions --json
npm run render
npm run verify
```

The blank starter is ten seconds, 960×540 at 30fps. Default `product-demo` has
three scenes, local sample art/music and a portrait graphic. Init writes files
without installing dependencies. Matching packages must exist in your package
source; prerelease users need the matching package tarballs from their builder.

Rendering needs the native renderer and Electron. Public native downloads are
currently unavailable. Obtain a complete local runtime archive and trusted SHA-256
from your builder, run `velocast setup --from <archive> --sha256 <hash>`, then doctor.
Do not claim an unavailable public install succeeded. A managed runtime is reused
without development environment variables. `velocast versions --json` reports it.

Update the CLI from the project's package source, then `velocast skills update`.
Updates replace only unchanged managed files and retain additional files. A local
edit conflict stops the update before writing any files. Install the new version
into a separate `--directory`, compare it with the customized skill, and merge
deliberately. A foreign installation or invalid receipt also needs a separate
destination. Interrupted updates may require that same comparison. Keep normal
version control for customized skills.
