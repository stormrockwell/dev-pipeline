export function WebhookDeliveries({ deliveries }) {
  return (
    <section>
      <h2>Webhook deliveries</h2>
      <ul>
        {deliveries.map((delivery) => (
          <li key={delivery.id}>{delivery.event}</li>
        ))}
      </ul>
    </section>
  );
}
