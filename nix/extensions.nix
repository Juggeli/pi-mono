{ lib, stdenv }:

stdenv.mkDerivation {
  pname = "pi-extensions";
  version = "0.54.2";

  src = ../packages/coding-agent/built-in-extensions;

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp package.json $out/
    cp synthetic.ts tps.ts ask-user.ts exa-tools.ts grep-code-search.ts openrouter.ts $out/
    cp -r subagent $out/
    runHook postInstall
  '';

  meta = {
    description = "pi custom extensions";
    license = lib.licenses.mit;
  };
}
