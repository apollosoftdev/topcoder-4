# Build stage
FROM maven:3.8-openjdk-8 AS builder
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn clean package -DskipTests

# Runtime stage
FROM openjdk:8-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/java-scorer-1.0.0.jar ./java-scorer.jar
COPY scripts/ ./scripts/
RUN chmod +x scripts/*.sh
ENTRYPOINT ["./scripts/entrypoint.sh"] 