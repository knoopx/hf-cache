{
  description = "A TUI app to browse and manage locally downloaded Hugging Face models and datasets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};
    py = pkgs.python314;
  in {
    packages.${system}.default = py.pkgs.buildPythonPackage rec {
      pname = "hf-cache";
      version = "0.1.0";
      src = ./.;

      pyproject = true;
      build-system = [py.pkgs.setuptools py.pkgs.wheel];

      propagatedBuildInputs = with py.pkgs; [
        rich
        textual
      ];

      doCheck = false;
    };

    apps.${system}.default = {
      type = "app";
      program = "${self.packages.${system}.default}/bin/hf-cache";
    };
  };
}
