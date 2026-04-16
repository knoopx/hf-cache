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
  in {
    packages.${system}.default = pkgs.python3Packages.buildPythonPackage rec {
      pname = "hf-cache";
      version = "0.1.0";
      src = ./.;

      pyproject = true;
      build-system = [pkgs.python3Packages.setuptools pkgs.python3Packages.wheel];

      propagatedBuildInputs = with pkgs.python3Packages; [
        huggingface-hub
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
