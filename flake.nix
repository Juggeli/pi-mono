{
  description = "pi - coding agent";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          pi = pkgs.callPackage ./nix/pi.nix { };
          pi-extensions = pkgs.callPackage ./nix/extensions.nix { };
          default = self.packages.${system}.pi;
        }
      );
    };
}
