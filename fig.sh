#!/bin/sh

FIG=./rho.toml
BUN=bun

{ echo "# GENERATED FILE DO NOT EDIT";
  echo "# ... serves as example only!";
  echo
} > $FIG

$BUN run init - >> $FIG

echo "done. $FIG" 1>&2
