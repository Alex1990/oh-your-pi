#!/bin/sh
# Install this oyp build for the current user and add it to PATH.
#
#   sh install.sh                 # ~/.local/share/oyp, PATH in ~/.zshrc
#   sh install.sh --shell bash    # PATH in ~/.bashrc
#   PI_INSTALL_DIR=... sh install.sh
set -eu

usage() {
	cat <<'EOF'
usage: sh install.sh [--shell zsh|bash]

Copies this build to $PI_INSTALL_DIR (default ~/.local/share/oyp) and adds
that directory to PATH through a managed block in ~/.zshrc (default) or
~/.bashrc.
EOF
}

src=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
shell_name=zsh
while [ $# -gt 0 ]; do
	case "$1" in
	--shell)
		shell_name=${2:-}
		[ -n "$shell_name" ] || {
			echo "--shell needs a value: zsh or bash" >&2
			exit 2
		}
		shift 2
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		echo "unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

case "$shell_name" in
zsh) rc_file=$HOME/.zshrc ;;
bash) rc_file=$HOME/.bashrc ;;
*)
	echo "--shell must be zsh or bash (got '$shell_name')" >&2
	exit 2
	;;
esac

install_dir=${PI_INSTALL_DIR:-$HOME/.local/share/oyp}
case "$install_dir" in
"" | "/")
	echo "refusing to install into '$install_dir'" >&2
	exit 1
	;;
esac
if [ ! -f "$src/runtime/node" ]; then
	echo "$src does not look like an oyp build (runtime/node is missing)" >&2
	exit 1
fi
# Same directory reached through another spelling: the copy below starts with a
# recursive delete, so compare the physical directory too, not just the string.
if [ "$src" = "$install_dir" ] || { [ -d "$install_dir" ] && [ "$src" -ef "$install_dir" ]; }; then
	echo "This copy is already the installed directory: $install_dir" >&2
	exit 1
fi

echo "Installing to $install_dir"
rm -rf "$install_dir"
mkdir -p "$install_dir"
cp -R "$src"/. "$install_dir"/
# Archives built on Windows carry no executable bits; restore the two programs
# this bundle needs.
chmod 755 "$install_dir/oyp" "$install_dir/runtime/node"

begin_marker='# >>> oyp >>>'
end_marker='# <<< oyp <<<'
mkdir -p "$HOME"
touch "$rc_file"
stripped=$rc_file.oyp.$$
trap 'rm -f "$stripped"' EXIT
awk -v begin="$begin_marker" -v end="$end_marker" '
	$0 == begin { skip = 1; next }
	$0 == end { skip = 0; next }
	skip { next }
	{ line[++count] = $0 }
	END {
		# Drop the blank lines that preceded the managed block so repeated runs
		# leave the file byte-identical.
		while (count > 0 && line[count] ~ /^[ \t]*$/) count--
		for (row = 1; row <= count; row++) print line[row]
	}
' "$rc_file" >"$stripped"
{
	cat "$stripped"
	if [ -s "$stripped" ]; then printf '\n'; fi
	printf '%s\nexport PATH="%s:$PATH"\n%s\n' "$begin_marker" "$install_dir" "$end_marker"
} >"$rc_file"
rm -f "$stripped"
trap - EXIT

if ! "$install_dir/oyp" --version; then
	echo "installed oyp cannot start; removing $install_dir" >&2
	rm -rf "$install_dir"
	exit 1
fi

echo
echo "Installed oyp to $install_dir"
echo "Added it to PATH in $rc_file"
echo "Open a new terminal, or run: . \"$rc_file\""
