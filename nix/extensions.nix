{ lib, stdenv }:

stdenv.mkDerivation {
  pname = "pi-extensions";
  version = "0.52.12";

  src = ../.pi/extensions;

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp synthetic.ts tps.ts $out/
    runHook postInstall
  '';

  meta = {
    description = "pi custom extensions";
    license = lib.licenses.mit;
  };
}
