import { API, graphqlOperation } from 'aws-amplify'
import { getBackups } from '../graphql/queries'
import { createBackup as createBackupQL } from '../graphql/mutations'

export const RECEIVE_BACKUP_CHANGES = 'RECEIVE_BACKUP_CHANGES'

export const receiveBackupChanges = (backupChanges) => ({
    type: RECEIVE_BACKUP_CHANGES,
    backupChanges
})

export const fetchBackups = (dispatch) => {
    return API.graphql(graphqlOperation(getBackups))
        .then(({ data }) => (data || {}))
        .then(({ getBackups }) => (getBackups || []))
        .then((backupChanges) => (dispatch(receiveBackupChanges(backupChanges))))
}

export const createBackup = ({ Name, Description }) => (dispatch) => {
    return API.graphql(graphqlOperation(createBackupQL, { Name, Description }))
}
