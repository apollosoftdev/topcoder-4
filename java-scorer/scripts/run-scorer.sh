#!/bin/sh

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <challengeId> <scorerType> <submissionId>"
  exit 1
fi

java -Xms512M -Xmx512M -jar target/java-scorer.jar $1 $2 $3 