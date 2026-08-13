// Command control is the Layup control plane: identity, presence, layup
// membership, social requests and WebRTC signalling. It is never in the 1:1
// media path.
package main

import (
	"fmt"
	"os"

	"github.com/layup-app/layup/protocol"
)

// Build is stamped by the release build; the default keeps local runs honest.
var Build = "dev"

func main() {
	fmt.Printf("layup-control %s (protocol v%d)\n", Build, protocol.Version)
	os.Exit(0)
}
