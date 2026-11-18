import { APP_NAME } from '../../shared/constants'

export default function App(): React.JSX.Element {
  return (
    <div className="app">
      <h1 className="app-title">{APP_NAME}</h1>
    </div>
  )
}
