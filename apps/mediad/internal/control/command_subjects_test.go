package control

import (
	"slices"
	"testing"
)

func TestCommandSubjectsMatchTheHandlerTable(t *testing.T) {
	s := &Server{}
	registered := s.handlerSubjects()
	if !slices.Equal(registered, CommandSubjects) {
		t.Fatalf("CommandSubjects = %v\nhandlers register %v", CommandSubjects, registered)
	}
}
